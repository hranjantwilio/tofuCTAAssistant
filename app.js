/**
 * Tofu CTA Assistant Express App
 * Serves as the main entry point for the application
 */
const express = require('express');
const app = express();

// Import modules
const salesforce = require('./salesforce');
const wiseowl = require('./wiseowl');

// Middleware to parse JSON bodies
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Health check endpoint
app.get('/health', (_, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Create job record in Salesforce and return jobId immediately
app.post('/jobs', async (req, res) => {
  try {
    const {
      sfdcToken,
      access_token, // for the external API (wise-owl)
      message,
      recordId, // Used as parentRecordId
      isProd = true
    } = req.body;
    
    // Use recordId as parentRecordId
    const parentRecordId = recordId;

    if (!sfdcToken || !parentRecordId) {
      return res.status(400).json({ error: 'Missing required parameter: sfdcToken and parentRecordId required' });
    }

    // Create Salesforce connection
    let conn;
    try {
      conn = await salesforce.createSalesforceConnection(sfdcToken);
    } catch (connError) {
      console.error('Failed to create Salesforce connection:', connError.message);
      return res.status(500).json({ error: 'Failed to connect to Salesforce', message: connError.message });
    }

    // Check for existing record and create if needed
    let conversationIdToUse = null;
    try {
      if (!access_token) {
        return res.status(400).json({ 
          error: 'Missing access_token: required to initialize conversation when none exists' 
        });
      }
      
      // Get or create the conversation record in Salesforce
      const recordInfo = await salesforce.manageConversationRecord(conn, parentRecordId, null);
      const { sfdcId, existingConversationId, isExisting } = recordInfo;
      
      // If we have an existing conversation ID, use it
      conversationIdToUse = existingConversationId;
      
      // If no conversation ID exists yet, create one
      if (!conversationIdToUse) {
        console.log('Creating new conversation...');
        conversationIdToUse = await wiseowl.createConversation(access_token, isProd);
        
        // Update the record with the new conversation ID if needed
        if (sfdcId && !existingConversationId) {
          try {
            await conn.sobject(process.env.SFDC_OBJECT_API_NAME || 'WO_Conversation__c').update({
              Id: sfdcId,
              Conversation_Id__c: conversationIdToUse
            });
          } catch (updateError) {
            console.error('Failed to update record with conversation ID:', updateError.message);
          }
        }
      }
      
      // Return the Salesforce record id immediately to the caller
      res.status(201).json({ recordId: sfdcId });

      // Start async processing in background (don't await)
      processInBackground({
        sfdcId,
        sfdcToken,
        access_token,
        recordId: parentRecordId,
        message,
        conversationId: conversationIdToUse,
        isExisting,
        isProd
      });
      
    } catch (err) {
      console.error('Error in conversation management:', err.message);
      return res.status(500).json({ error: 'Error in conversation management', message: err.message });
    }
  } catch (err) {
    console.error('Failed to create SFDC record:', err.message);
    res.status(500).json({ error: 'Failed to create SFDC record', message: err.message });
  }
});

/**
 * Processes the job in the background
 * @param {object} params - Parameters for processing
 */
async function processInBackground(params) {
  const { 
    sfdcId, 
    sfdcToken, 
    access_token, 
    recordId, 
    message, 
    conversationId, 
    isExisting,
    isProd 
  } = params;

  try {
    // Create Salesforce connection for processing
    const conn = await salesforce.createSalesforceConnection(sfdcToken);
    
    // Set up data and prompt based on whether this is an existing conversation
    let wrapperDataString = "{}";
    
    // Only collect data if this is a new conversation
    if (!isExisting) {
      try {
        const ctaData = await salesforce.collectAllCTAData(conn, recordId);
        console.log('Successfully collected CTA data for background job');
        wrapperDataString = JSON.stringify(ctaData, null, 2);
      } catch (dataError) {
        console.error('Error collecting CTA data:', dataError);
      }
    } else {
      console.log('Using existing conversation, skipping data collection');
    }
    
    // Build the prompt
    console.log('Building prompt with conversation ID:', conversationId);
    const input = wiseowl.buildPrompt({
      message,
      conversationId,
      wrapperDataString
    });
    console.log('Prompt built successfully, sending to WiseOwl');
    
    // Process the conversation with WiseOwl
    console.log('Starting WiseOwl conversation processing');
    const result = await wiseowl.processConversation({
      accessToken: access_token,
      input,
      context: "the user is not on a record page to provide any context",
      conversationId,
      isProd
    });
    console.log('WiseOwl processing completed');
    
    // Update the Salesforce record with the result
    await salesforce.updateConversationRecord(conn, sfdcId, result.assistantContent, !message);
    
    console.log(`Background processing completed for SFDC record ${sfdcId}`);
  } catch (bgErr) {
    console.error('Background job failed:', bgErr?.message || bgErr);
  }
}

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
  console.log(`POST /jobs available at http://localhost:${PORT}/jobs`);
});

module.exports = app;
