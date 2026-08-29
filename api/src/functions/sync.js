const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');

const connectionString = process.env.COSMOS_CONNECTION_STRING;
const dbName = process.env.COSMOS_DB_NAME || 'psat-prep-db';

let container = null;
function getContainer() {
  if (!container && connectionString) {
    const client = new CosmosClient(connectionString);
    container = client.database(dbName).container('UATStudentAnswers');
  }
  return container;
}

app.http('sync', {
  methods: ['GET', 'POST', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    if (request.method === 'OPTIONS') {
      return { status: 204 };
    }

    const c = getContainer();
    if (!c) {
      return { status: 500, jsonBody: { error: 'Cosmos DB connection not configured' } };
    }

    const studentName = request.query.get('student_name') || 'default_student';

    if (request.method === 'GET') {
      try {
        const querySpec = {
          query: 'SELECT * FROM c WHERE c.student_name = @student',
          parameters: [{ name: '@student', value: studentName }]
        };
        const { resources } = await c.items.query(querySpec).fetchAll();

        let masterDoc = null;
        const examDocs = [];

        (resources || []).forEach(doc => {
          if (doc.id === `student_${studentName}`) {
            masterDoc = doc;
          } else if (doc.doc_type === 'exam_session') {
            examDocs.push(doc);
          }
        });

        if (!masterDoc && examDocs.length === 0) {
          return { status: 200, jsonBody: { success: true, exists: false, data: null } };
        }

        // Merge all historical exams across master and individual immutable session docs
        const examMap = {};
        (masterDoc?.examHistory || []).forEach(e => { if (e && e.examId) examMap[e.examId] = e; });
        examDocs.forEach(e => { if (e && e.examId) examMap[e.examId] = e; });
        const mergedExams = Object.values(examMap).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

        const compositeData = {
          id: `student_${studentName}`,
          student_name: studentName,
          progress: masterDoc?.progress || {},
          srsState: masterDoc?.srsState || {},
          sessionsState: masterDoc?.sessionsState || {},
          examHistory: mergedExams,
          updatedAt: masterDoc?.updatedAt || Date.now()
        };

        return { status: 200, jsonBody: { success: true, exists: true, data: compositeData } };
      } catch (err) {
        context.error('Error reading from Cosmos DB:', err);
        return { status: 500, jsonBody: { error: err.message } };
      }
    }

    if (request.method === 'POST') {
      try {
        const body = await request.json();
        const targetStudent = body.student_name || studentName;
        const now = Date.now();
        const masterDocId = `student_${targetStudent}`;

        // Read existing master document for non-destructive server-side merge
        let existingMaster = null;
        try {
          const { resource } = await c.item(masterDocId, targetStudent).read();
          existingMaster = resource;
        } catch (readErr) {
          if (readErr.statusCode === 404) {
            // Document does not exist yet; first push for this student
            existingMaster = null;
          } else {
            context.error('Cosmos DB read error on master profile:', readErr);
            return { status: 503, jsonBody: { error: 'Database read failed. Please retry.' } };
          }
        }

        // 1. Server-side merge progress (retains all historical question attempts, newer timestamp wins)
        const mergedProgress = Object.assign({}, existingMaster?.progress || {});
        Object.entries(body.progress || {}).forEach(([qid, p]) => {
          if (!p) return;
          const existing = mergedProgress[qid];
          if (!existing || (p.timestamp || 0) >= (existing.timestamp || 0)) {
            mergedProgress[qid] = p;
          }
        });

        // 2. Server-side merge SRS cards (newer lastReviewedAt wins)
        const mergedSrs = Object.assign({}, existingMaster?.srsState || {});
        Object.entries(body.srsState || {}).forEach(([qid, card]) => {
          if (!card) return;
          const existing = mergedSrs[qid];
          if (!existing || (card.lastReviewedAt || 0) >= (existing.lastReviewedAt || 0)) {
            mergedSrs[qid] = card;
          }
        });

        // 3. Server-side merge daily sessions
        const mergedSessions = Object.assign({}, existingMaster?.sessionsState || {});
        Object.entries(body.sessionsState || {}).forEach(([dStr, sess]) => {
          if (!sess) return;
          const existing = mergedSessions[dStr];
          if (existing && sess.questionsAnswered) {
            mergedSessions[dStr] = {
              date: dStr,
              questionsAnswered: Math.max(existing.questionsAnswered || 0, sess.questionsAnswered || 0),
              correct: Math.max(existing.correct || 0, sess.correct || 0),
              totalTimeMs: Math.max(existing.totalTimeMs || 0, sess.totalTimeMs || 0)
            };
          } else {
            mergedSessions[dStr] = sess;
          }
        });

        // 4. Server-side merge exam history (deduplicated by examId)
        const examMap = {};
        (existingMaster?.examHistory || []).forEach(e => { if (e && e.examId) examMap[e.examId] = e; });
        (body.examHistory || []).forEach(e => { if (e && e.examId) examMap[e.examId] = e; });
        const mergedExams = Object.values(examMap).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

        const masterDoc = {
          id: masterDocId,
          student_name: targetStudent,
          doc_type: 'student_master_profile',
          progress: mergedProgress,
          srsState: mergedSrs,
          sessionsState: mergedSessions,
          examHistory: mergedExams.slice(0, 50),
          updatedAt: now,
          clientTimestamp: body.clientTimestamp || new Date().toISOString()
        };
        await c.items.upsert(masterDoc);

        // 2. Immutable individual exam records for long-term longitudinal persistence
        if (Array.isArray(body.examHistory)) {
          for (const exam of body.examHistory) {
            if (exam && exam.examId) {
              const examDocId = `exam_${targetStudent}_${exam.examId}`;
              const examDoc = Object.assign({}, exam, {
                id: examDocId,
                student_name: targetStudent,
                doc_type: 'exam_session',
                persistedAt: now
              });
              try {
                await c.items.create(examDoc);
              } catch (err) {
                // HTTP 409 (Conflict) means the immutable record is already safely stored
                if (err.statusCode !== 409) {
                  context.warn(`Warning creating immutable exam doc ${examDocId}:`, err.message);
                }
              }
            }
          }
        }

        const ackOpIds = Array.isArray(body.outboxOps) ? body.outboxOps.map(op => op.id).filter(Boolean) : [];

        return { status: 200, jsonBody: { success: true, updatedAt: now, ackOpIds: ackOpIds } };
      } catch (err) {
        context.error('Error writing to Cosmos DB:', err);
        return { status: 500, jsonBody: { error: err.message } };
      }
    }

    return { status: 405, jsonBody: { error: 'Method not allowed' } };
  }
});
