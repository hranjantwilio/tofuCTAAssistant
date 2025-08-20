const express = require('express');
const axios = require('axios');
const https = require('https');
const compression = require('compression');
const app = express();

// Constants
const INGRESS = "SALESFORCE";
const APPLICATION_ID = "wiseowl-salesforce-application";
// SFDC instance URL (can be overridden via env var)
const SFDC_INSTANCE_URL = process.env.SFDC_INSTANCE_URL || 'https://twlo--full.sandbox.my.salesforce.com';

// Middleware to parse JSON bodies
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// Enable gzip compression for responses
app.use(compression());

// Keep-alive agent to reuse TCP/TLS connections
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: parseInt(process.env.MAX_SOCKETS || '50') });

// Dedicated axios instances for Twilio and Salesforce with sensible timeouts
const axiosTwilio = axios.create({ httpsAgent: keepAliveAgent, timeout: parseInt(process.env.TWILIO_TIMEOUT_MS || '30000') });
const axiosSfdc = axios.create({ httpsAgent: keepAliveAgent, timeout: parseInt(process.env.SFDC_TIMEOUT_MS || '15000') });

// Simple retry helper for transient errors
async function axiosRequestWithRetry(instance, config, retries = 2, backoffMs = 300) {
  let attempt = 0;
  while (true) {
    try {
      return await instance.request(config);
    } catch (err) {
      attempt++;
      const status = err.response?.status;
      const isRetryable = !err.response || (status >= 500 && status < 600);
      if (!isRetryable || attempt > retries) throw err;
      const wait = backoffMs * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// Simple in-memory job queue with concurrency limit
const jobsQueue = [];
let activeJobs = 0;
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || '5');
function enqueueJob(job) {
  jobsQueue.push(job);
  maybeProcessQueue();
}
function maybeProcessQueue() {
  while (activeJobs < MAX_CONCURRENT_JOBS && jobsQueue.length > 0) {
    const job = jobsQueue.shift();
    activeJobs++;
    (async () => {
      try {
        await processJobAsync(job);
      } catch (e) {
        console.error('Background job failed:', e?.message || e);
      } finally {
        activeJobs--;
        setImmediate(maybeProcessQueue);
      }
    })();
  }
}

// Default POST endpoint
app.post('/', async (req, res) => {
  try {
    const { access_token, input, context, conversationId, isProd = true } = req.body;

    // Validate required parameters
    if (!access_token || !input || !context) {
      return res.status(400).json({ 
        error: 'Missing required parameters: access_token, input, context' 
      });
    }

    // Convert access token to base64 encoded auth object
    const authObject = {
      authToken: access_token,
      authTokenType: INGRESS
    };
    const encodedAuthToken = Buffer.from(JSON.stringify(authObject)).toString('base64');

    // Set base URL based on environment
    const domain = isProd ? 'https://www.twilio.com' : 'https://www.dev.twilio.com';
    const baseUrl = `${domain}/wise-owl/api/v2/conversations`;
    
    const headers = {
      'x-twilio-e2-ingress': INGRESS,
      'x-twilio-e2-auth-token': encodedAuthToken,
      'Content-Type': 'application/json'
    };

    // Step 1: Create conversation with POST (if conversationId not provided)
    let finalConversationId = conversationId;
    let runId;
    
    if (!finalConversationId) {
      try {
        console.log(`Creating conversation in ${domain}...`);
        const postResponse = await axiosRequestWithRetry(axiosTwilio, {
          method: 'post',
          url: baseUrl,
          data: { applicationId: APPLICATION_ID },
          headers
        });

        finalConversationId = postResponse.data.conversation.id;
        console.log(`Conversation created with ID: ${finalConversationId}`);
      } catch (postError) {
        console.error('Failed to create conversation:', JSON.stringify(postError.message));
        throw new Error(`Conversation creation failed: ${postError.response?.data || postError.message}`);
      }
    } else {
      console.log(`Using provided conversation ID: ${finalConversationId}`);
    }

    // Step 2: Send input with PUT
    const putUrl = `${baseUrl}/${finalConversationId}`;
    try {
      console.log('Sending input to conversation...');
      const putResponse = await axiosRequestWithRetry(axiosTwilio, {
        method: 'put',
        url: putUrl,
        data: {
          applicationId: APPLICATION_ID,
          input: input,
          streamMode: "polling",
          systemContext: { pageContext: context }
        },
        headers
      });

      runId = putResponse.data.runId;
      console.log(`PUT request initiated with runId: ${runId}`);
    } catch (putError) {
      console.error('Failed to send input to conversation:', putError.message);
      throw new Error(`Input submission failed: ${putError.response?.data || putError.message}`);
    }

    // Step 3: Poll for completion
    console.log('Starting polling for completion...');
    const pollUrl = `${putUrl}/runs/${runId}`;
    let isDone = false;
    let chatDone = null;
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 5; // Stop after 5 consecutive failures

    // Poll every 2 seconds until done
    while (!isDone) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
      
      try {
  const pollResponse = await axiosRequestWithRetry(axiosTwilio, { method: 'get', url: pollUrl, headers });
        const responseData = pollResponse.data;
        
        console.log('Polling response received...');
        consecutiveErrors = 0; // Reset error counter on successful response
        
        // Check if the response indicates completion
        if (Array.isArray(responseData) && responseData.length > 0) {
          const firstElement = responseData[0];
          if (Array.isArray(firstElement) && firstElement.length > 0 && firstElement[0] === 'done') {
            isDone = true;
            chatDone = firstElement[1]; // Everything after "done"
            console.log('Conversation completed!');
          }
        }
      } catch (pollError) {
        consecutiveErrors++;
        console.error(`Error during polling (attempt ${consecutiveErrors}/${maxConsecutiveErrors}):`, pollError.message);
        
        // Stop polling after too many consecutive errors
        if (consecutiveErrors >= maxConsecutiveErrors) {
          console.error('Too many consecutive polling errors. Stopping polling.');
          throw new Error(`Polling failed after ${maxConsecutiveErrors} consecutive attempts: ${pollError.response?.data || pollError.message}`);
        }
        
        // For persistent client errors (4xx), stop immediately
        if (pollError.response?.status >= 400 && pollError.response?.status < 500) {
          console.error('Client error during polling. Stopping polling.');
          throw new Error(`Polling failed with client error: ${pollError.response.status} - ${pollError.response?.data || pollError.message}`);
        }
      }
    }

    // Return the chat completion data
    res.json({
      success: true,
      runId: runId,
      conversationId: finalConversationId,
      chatDone: chatDone
    });

  } catch (error) {
    console.error('Error in main workflow:', error.message);
    
    // Return appropriate error response
    if (error.response) {
      // API error
      res.status(error.response.status).json({
        error: 'API Error',
        message: error.response.data || error.message,
        status: error.response.status
      });
    } else {
      // Network or other error
      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    }
  }
});

// Create job record in Salesforce and return jobId immediately
app.post('/jobs', async (req, res) => {
  try {
    const {
      sfdcToken,
      access_token, // for the external API (wise-owl)
      input,
      context,
      conversationId: providedConversationId,
      parentRecordId,
      conversationHistory: initialConversationHistory,
      isProd = true
    } = req.body;

  if (!sfdcToken || !parentRecordId) {
      return res.status(400).json({ error: 'Missing required parameter: sfdcToken and parentRecordId required' });
    }

    const instanceUrl = SFDC_INSTANCE_URL;
    const sfdcObject = process.env.SFDC_OBJECT_API_NAME || 'WO_Conversation__c';

    const headers = { Authorization: `Bearer ${sfdcToken}`, 'Content-Type': 'application/json' };

    // Check for existing record by Parent_Record_Id__c
    const soql = `SELECT Id, Conversation_Id__c, Conversation_History__c FROM ${sfdcObject} WHERE Parent_Record_Id__c='${encodeURIComponent(parentRecordId)}' LIMIT 1`;
    const queryUrl = `${instanceUrl}/services/data/v57.0/query?q=${encodeURIComponent(soql)}`;
    let sfdcId = null;
    let existingConversationId = null;
    let existingHistory = '';

    try {
      const qresp = await axiosRequestWithRetry(axiosSfdc, { method: 'get', url: queryUrl, headers });
      if (qresp.data && qresp.data.totalSize > 0 && qresp.data.records && qresp.data.records.length > 0) {
        const rec = qresp.data.records[0];
        sfdcId = rec.Id;
        existingConversationId = rec.Conversation_Id__c || null;
        existingHistory = rec.Conversation_History__c || '';
        console.error('Using existing conversation:', existingConversationId);
      }
    } catch (qerr) {
      // Query failed; continue to create new record
      console.error('SOQL query failed:', qerr.message);
    }

    // Determine or initialize conversationId to use
    let conversationIdToUse = existingConversationId || providedConversationId || null;

    // If no conversationId yet, we must create one synchronously via external API
    if (!conversationIdToUse) {
      if (!access_token) {
        return res.status(400).json({ error: 'Missing access_token: required to initialize conversation when none exists' });
      }
      console.log('Creating new conversation...');
      const domainForCreate = isProd ? 'https://www.twilio.com' : 'https://www.dev.twilio.com';
      const baseCreateUrl = `${domainForCreate}/wise-owl/api/v2/conversations`;
      const encodedAuthTokenLocal = Buffer.from(JSON.stringify({ authToken: access_token, authTokenType: INGRESS })).toString('base64');
      const createHeaders = {
        'x-twilio-e2-ingress': INGRESS,
        'x-twilio-e2-auth-token': encodedAuthTokenLocal,
        'Content-Type': 'application/json'
      };

  const postResp = await axiosRequestWithRetry(axiosTwilio, { method: 'post', url: baseCreateUrl, data: { applicationId: APPLICATION_ID }, headers: createHeaders });
      conversationIdToUse = postResp.data.conversation?.id;

      if (!conversationIdToUse) {
        return res.status(500).json({ error: 'Failed to initialize conversation' });
      }

      // If record exists, patch it to set Conversation_Id__c
      if (sfdcId) {
  const patchUrlExisting = `${instanceUrl}/services/data/v57.0/sobjects/${sfdcObject}/${sfdcId}`;
  await axiosRequestWithRetry(axiosSfdc, { method: 'patch', url: patchUrlExisting, data: { Conversation_Id__c: conversationIdToUse }, headers });
      }
    }

    if (!sfdcId) {
      // Create new record with conversation id
      const createUrl = `${instanceUrl}/services/data/v57.0/sobjects/${sfdcObject}/`;
      const createPayload = {
        Conversation_Id__c: conversationIdToUse || null,
        Parent_Record_Id__c: parentRecordId,
        Conversation_History__c: initialConversationHistory || '',
        Chat_Done__c: false
      };
  const createResp = await axiosRequestWithRetry(axiosSfdc, { method: 'post', url: createUrl, data: createPayload, headers });
  sfdcId = createResp.data.id;
    }

    // Ensure record is marked as processing (Chat_Done__c = false) and clear current_conversation__c
    try {
  const patchUrlProcessing = `${instanceUrl}/services/data/v57.0/sobjects/${sfdcObject}/${sfdcId}`;
  await axiosRequestWithRetry(axiosSfdc, { method: 'patch', url: patchUrlProcessing, data: { Chat_Done__c: false, current_conversation__c: '' }, headers });
    } catch (ppErr) {
      console.error('Failed to mark record processing:', ppErr.message);
    }

    // Return the Salesforce record id immediately to the caller
    res.status(201).json({ recordId: sfdcId });

    // Enqueue async processing to be handled by in-process worker (respects concurrency limits)
    enqueueJob({
      sfdcId,
      sfdcToken,
      access_token,
      input,
      context,
      conversationId: conversationIdToUse || null,
      isProd
    });

  } catch (err) {
    console.error('Failed to create SFDC record:', err.message);
    res.status(500).json({ error: 'Failed to create SFDC record', message: err.message });
  }
});

// No GET /jobs endpoint — synchronous API returns SFDC record id and starts background processing

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// --- Worker functions (embedded) -----------------------------------------
// In-process async processor that performs the conversation flow and patches SFDC record
async function processJobAsync({ sfdcId, sfdcToken, access_token, input, context, conversationId, isProd }) {
  // Call the external conversation API flow (create conversation if needed, PUT input, poll for completion)
  console.log(`Processing background job for SFDC record ${sfdcId}`);

  if (!access_token) throw new Error('Missing access_token for conversation API');

  const encodedAuthToken = Buffer.from(JSON.stringify({ authToken: access_token, authTokenType: INGRESS })).toString('base64');
  const domain = isProd ? 'https://www.twilio.com' : 'https://www.dev.twilio.com';
  const baseUrl = `${domain}/wise-owl/api/v2/conversations`;
  const headers = {
    'x-twilio-e2-ingress': INGRESS,
    'x-twilio-e2-auth-token': encodedAuthToken,
    'Content-Type': 'application/json'
  };

  // Step 1: Create conversation if necessary
  let finalConversationId = conversationId;
  if (!finalConversationId) {
    const postResponse = await axiosRequestWithRetry(axiosTwilio, { method: 'post', url: baseUrl, data: { applicationId: APPLICATION_ID }, headers });
    finalConversationId = postResponse.data.conversation?.id;
  }

  if (!finalConversationId) throw new Error('Failed to obtain conversationId from external API');

  // Step 2: PUT input
  const putUrl = `${baseUrl}/${finalConversationId}`;
  const putResp = await axiosRequestWithRetry(axiosTwilio, { method: 'put', url: putUrl, data: { applicationId: APPLICATION_ID, input, streamMode: 'polling', systemContext: { pageContext: context } }, headers });

  const runId = putResp.data.runId;
  if (!runId) throw new Error('Failed to start conversation run');

  // Step 3: Poll for completion
  const pollUrl = `${putUrl}/runs/${runId}`;
  let isDoneLocal = false;
  let chatDoneResult = null;
  let consecutiveErrors = 0;
  const maxConsecutiveErrors = 5;

  while (!isDoneLocal) {
    await new Promise(r => setTimeout(r, 2000));
    try {
  const pollResponse = await axiosRequestWithRetry(axiosTwilio, { method: 'get', url: pollUrl, headers });
      const responseData = pollResponse.data;
      consecutiveErrors = 0;
      if (Array.isArray(responseData) && responseData.length > 0) {
        const firstElement = responseData[0];
        if (Array.isArray(firstElement) && firstElement.length > 0 && firstElement[0] === 'done') {
          isDoneLocal = true;
          chatDoneResult = firstElement[1];
        }
      }
    } catch (pollError) {
      consecutiveErrors++;
      if (consecutiveErrors >= maxConsecutiveErrors) throw pollError;
      if (pollError.response?.status >= 400 && pollError.response?.status < 500) throw pollError;
    }
  }

  // Step 4: PATCH the existing WO_Conversation__c record with conversation history and set Chat_Done__c = true
  const instanceUrl = SFDC_INSTANCE_URL;
  if (!instanceUrl) throw new Error('SFDC_INSTANCE_URL not configured');
  const sfdcObject = process.env.SFDC_OBJECT_API_NAME || 'WO_Conversation__c';
  const patchUrl = `${instanceUrl}/services/data/v57.0/sobjects/${sfdcObject}/${sfdcId}`;

  // Extract assistant response content (prefer MARKDOWN part) from chatDoneResult
  let assistantContent = '';
  try {
    if (Array.isArray(chatDoneResult)) {
      // Find the first message where role indicates assistant
      const assistantEntry = chatDoneResult.find(m => (m.role && m.role.toUpperCase() === 'ASSISTANT'));
      if (assistantEntry) {
        // Prefer parts with type MARKDOWN
        if (Array.isArray(assistantEntry.parts) && assistantEntry.parts.length > 0) {
          const md = assistantEntry.parts.find(p => p.type && p.type.toUpperCase() === 'MARKDOWN');
          if (md && md.content) assistantContent = md.content;
          else if (assistantEntry.parts[0].content) assistantContent = assistantEntry.parts[0].content;
        } else if (assistantEntry.content) {
          assistantContent = assistantEntry.content;
        }
      }
    } else if (typeof chatDoneResult === 'string') {
      assistantContent = chatDoneResult;
    }
  } catch (e) {
    assistantContent = Array.isArray(chatDoneResult) ? JSON.stringify(chatDoneResult) : String(chatDoneResult || '');
  }

  // Fallback: store full result if no assistant content found
  if (!assistantContent) assistantContent = Array.isArray(chatDoneResult) ? JSON.stringify(chatDoneResult) : (chatDoneResult || '');

  // Fetch current Conversation_History__c (in case it changed) and append the new assistantContent as <li>
  const recordUrl = `${instanceUrl}/services/data/v57.0/sobjects/${sfdcObject}/${sfdcId}`;
  let currentHistory = '';
  try {
    const rr = await axiosRequestWithRetry(axiosSfdc, { method: 'get', url: recordUrl, headers: { Authorization: `Bearer ${sfdcToken}` } });
    currentHistory = rr.data.Conversation_History__c || '';
  } catch (e) {
    // ignore - we'll create new history
    console.error('Failed to fetch existing record history:', e.message);
  }

  // simple HTML escape
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const newLi = `<li>${escapeHtml(assistantContent)}</li>`;
  let newHistory = '';
  if (!currentHistory || currentHistory.trim() === '') {
    newHistory = `<ul>${newLi}</ul>`;
  } else {
    // attempt to insert into existing <ul> if present, else append new ul
    const ulCloseIndex = currentHistory.lastIndexOf('</ul>');
    if (ulCloseIndex !== -1) {
      newHistory = currentHistory.slice(0, ulCloseIndex) + newLi + currentHistory.slice(ulCloseIndex);
    } else {
      newHistory = currentHistory + `<ul>${newLi}</ul>`;
    }
  }


  const patchPayload = {
    Conversation_History__c: newHistory,
    Chat_Done__c: true,
    current_conversation__c: assistantContent
  };

  const sfdcHeaders = { Authorization: `Bearer ${sfdcToken}`, 'Content-Type': 'application/json' };
  await axiosRequestWithRetry(axiosSfdc, { method: 'patch', url: patchUrl, data: patchPayload, headers: sfdcHeaders });

  console.log(`Background processing completed for SFDC record ${sfdcId}`);
}

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
  console.log(`POST /jobs available at http://localhost:${PORT}/jobs`);
});

module.exports = app;
