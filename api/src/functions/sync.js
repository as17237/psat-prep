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

        // 1. Master state document
        const masterDocId = `student_${targetStudent}`;
        const masterDoc = {
          id: masterDocId,
          student_name: targetStudent,
          doc_type: 'student_master_profile',
          progress: body.progress || {},
          srsState: body.srsState || {},
          sessionsState: body.sessionsState || {},
          examHistory: (body.examHistory || []).slice(0, 30),
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
              await c.items.upsert(examDoc);
            }
          }
        }

        return { status: 200, jsonBody: { success: true, updatedAt: now } };
      } catch (err) {
        context.error('Error writing to Cosmos DB:', err);
        return { status: 500, jsonBody: { error: err.message } };
      }
    }

    return { status: 405, jsonBody: { error: 'Method not allowed' } };
  }
});
