const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');

const connectionString = process.env.COSMOS_CONNECTION_STRING;
const dbName = process.env.COSMOS_DB_NAME || 'psat-prep-db';

let feedbackContainer = null;
function getFeedbackContainer() {
  if (!feedbackContainer && connectionString) {
    const client = new CosmosClient(connectionString);
    feedbackContainer = client.database(dbName).container('UATFeedback');
  }
  return feedbackContainer;
}

app.http('feedback', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    if (request.method === 'OPTIONS') {
      return { status: 204 };
    }

    const c = getFeedbackContainer();
    if (!c) {
      return { status: 500, jsonBody: { error: 'Cosmos DB connection not configured' } };
    }

    try {
      const body = await request.json();
      const feedbackDoc = {
        id: `feedback_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        category: body.category || 'General',
        rating: body.rating || 5,
        comments: body.comments || body.feedback || '',
        name: body.name || 'Anonymous',
        email: body.email || '',
        submittedAt: new Date().toISOString(),
        userAgent: body.userAgent || ''
      };

      const { resource } = await c.items.create(feedbackDoc);
      return { status: 200, jsonBody: { success: true, id: resource.id } };
    } catch (err) {
      context.error('Error writing feedback to Cosmos DB:', err);
      return { status: 500, jsonBody: { error: err.message } };
    }
  }
});
