const express = require('express');
const axios = require('axios');
const app = express();

// Constants
const INGRESS = "SALESFORCE";
const APPLICATION_ID = "wiseowl-salesforce-application";

// Middleware to parse JSON bodies
app.use(express.json());

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
        const postResponse = await axios.post(baseUrl, {
          applicationId: APPLICATION_ID
        }, { headers });

        finalConversationId = postResponse.data.conversation.id;
        console.log(`Conversation created with ID: ${finalConversationId}`);
      } catch (postError) {
        console.error('Failed to create conversation:', postError.message);
        throw new Error(`Conversation creation failed: ${postError.response?.data || postError.message}`);
      }
    } else {
      console.log(`Using provided conversation ID: ${finalConversationId}`);
    }

    // Step 2: Send input with PUT
    const putUrl = `${baseUrl}/${finalConversationId}`;
    try {
      console.log('Sending input to conversation...');
      const putResponse = await axios.put(putUrl, {
        applicationId: APPLICATION_ID,
        input: input,
        streamMode: "polling",
        systemContext: {
          pageContext: context
        }
      }, { headers });

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
        const pollResponse = await axios.get(pollUrl, { headers });
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
  console.log(`Main endpoint available at http://localhost:${PORT}/`);
});

module.exports = app;
