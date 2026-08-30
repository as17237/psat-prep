const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');
const dm = require('../lib/datamodel.js');
const {
  classifyDocs,
  reassembleComposite,
  planWrite
} = require('../lib/shardsync.js');

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

/**
 * Every document this student owns, in ONE in-partition query.
 *
 * WI-11.5: the student's state is now spread over a master profile, up to 16
 * `progress_shard` documents, up to 16 `srs_shard` documents and one immutable
 * `exam_session` document per exam — all on the SAME `/student_name` partition key, so
 * this is still a single cheap query rather than a fan-out. GET already did exactly this
 * query; POST now does it too, because it must merge against the shards, not just the
 * master.
 */
async function readPartition(c, studentName) {
  const querySpec = {
    query: 'SELECT * FROM c WHERE c.student_name = @student',
    parameters: [{ name: '@student', value: studentName }]
  };
  const { resources } = await c.items.query(querySpec).fetchAll();
  return resources || [];
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
        const resources = await readPartition(c, studentName);

        // WI-11.5: the composite is reassembled from the master document AND the
        // progress/SRS shards AND the immutable exam_session docs, using the SAME
        // merge rules (api/src/lib/merge.js) the write path uses. The returned shape is
        // unchanged from v1 — same keys, same types — which is what lets the untouched
        // production client keep working against a sharded document set.
        const compositeData = reassembleComposite(resources, studentName, Date.now());

        if (!compositeData) {
          return { status: 200, jsonBody: { success: true, exists: false, data: null } };
        }

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

        // ------------------------------------------------------------------
        // 1. Read everything this student owns.
        //
        // A failure here is a HARD 503, never a "proceed with what we have":
        // the shard documents are replaced wholesale on write, so planning a write
        // against a partially-read partition could drop entries the client did not
        // resend. Reporting beats recovering-by-guessing (CLAUDE.md mode 5).
        // ------------------------------------------------------------------
        let partition;
        try {
          partition = await readPartition(c, targetStudent);
        } catch (readErr) {
          context.error('Cosmos DB read error on student partition:', readErr);
          return { status: 503, jsonBody: { error: 'Database read failed. Please retry.' } };
        }
        const held = classifyDocs(partition, targetStudent);

        // ------------------------------------------------------------------
        // 2. Immutable per-exam records FIRST.
        //
        // They are written before the master so that the exam-history index (which
        // drops `moduleReports` from the master's copy once shards are authoritative)
        // is only ever applied to an examId whose full report is confirmed durable.
        // ------------------------------------------------------------------
        const durableExamIds = held.exams.map(e => e.examId).filter(Boolean);
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
                durableExamIds.push(exam.examId);
              } catch (err) {
                if (err.statusCode === 409) {
                  // Already stored — the immutable record exists, which is all the
                  // index needs to know.
                  durableExamIds.push(exam.examId);
                } else {
                  context.warn(`Warning creating immutable exam doc ${examDocId}:`, err.message);
                }
              }
            }
          }
        }

        // ------------------------------------------------------------------
        // 3. Plan the write (pure — api/src/lib/shardsync.js).
        // ------------------------------------------------------------------
        const plan = planWrite({
          studentName: targetStudent,
          body: body,
          existingMaster: held.master,
          existingProgressShards: held.progressShards,
          existingSrsShards: held.srsShards,
          durableExamIds: durableExamIds,
          now: now
        });

        // ------------------------------------------------------------------
        // 4. Shards BEFORE the master.
        //
        // In shard-authoritative mode the shards are the truth, so if the process dies
        // between the two writes the durable state is the newer one, not the older.
        // ------------------------------------------------------------------
        for (const shard of plan.shardDocs) {
          await c.items.upsert(shard);
        }
        await c.items.upsert(plan.masterDoc);

        const ackOpIds = Array.isArray(body.outboxOps) ? body.outboxOps.map(op => op.id).filter(Boolean) : [];

        return {
          status: 200,
          jsonBody: {
            success: true,
            updatedAt: now,
            ackOpIds: ackOpIds,
            // Observability, not decoration: every one of these is a measurement of
            // what this request actually wrote.
            storage: {
              mode: plan.mode,
              shardsWritten: plan.shardDocs.length,
              shardsUnchanged: plan.unchangedShards,
              shardCount: dm.SHARD_COUNT,
              codecFallbacks: plan.fallbacks,
              progressEntries: plan.mergedProgressCount,
              srsCards: plan.mergedSrsCount
            }
          }
        };
      } catch (err) {
        context.error('Error writing to Cosmos DB:', err);
        return { status: 500, jsonBody: { error: err.message } };
      }
    }

    return { status: 405, jsonBody: { error: 'Method not allowed' } };
  }
});
