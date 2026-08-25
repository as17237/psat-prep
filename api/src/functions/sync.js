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
        const docId = `student_${studentName}`;
        const { resource } = await c.item(docId, studentName).read();
        if (!resource) {
          return { status: 200, jsonBody: { success: true, exists: false, data: null } };
        }
        return { status: 200, jsonBody: { success: true, exists: true, data: resource } };
      } catch (err) {
        if (err.statusCode === 404) {
          return { status: 200, jsonBody: { success: true, exists: false, data: null } };
        }
        context.error('Error reading from Cosmos DB:', err);
        return { status: 500, jsonBody: { error: err.message } };
      }
    }

    if (request.method === 'POST') {
      try {
        const body = await request.json();
        const targetStudent = body.student_name || studentName;
        const docId = `student_${targetStudent}`;

        const doc = {
          id: docId,
          student_name: targetStudent,
          progress: body.progress || {},
          srsState: body.srsState || {},
          sessionsState: body.sessionsState || {},
          examHistory: body.examHistory || [],
          updatedAt: Date.now(),
          clientTimestamp: body.clientTimestamp || new Date().toISOString()
        };

        await c.items.upsert(doc);
        return { status: 200, jsonBody: { success: true, updatedAt: doc.updatedAt } };
      } catch (err) {
        context.error('Error writing to Cosmos DB:', err);
        return { status: 500, jsonBody: { error: err.message } };
      }
    }

    return { status: 405, jsonBody: { error: 'Method not allowed' } };
  }
});
