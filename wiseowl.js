/**
 * WiseOwl Integration Module
 * Handles all interactions with the WiseOwl API
 */
const axios = require('axios');

// Constants
const INGRESS = "SALESFORCE";
const APPLICATION_ID = "wiseowl-salesforce-application";

/**
 * Creates a new WiseOwl conversation
 * @param {string} accessToken - Access token for the WiseOwl API
 * @param {boolean} isProd - Whether to use production or development environment
 * @returns {string} Conversation ID
 */
async function createConversation(accessToken, isProd = true) {
  if (!accessToken) {
    throw new Error('Missing access_token for WiseOwl API');
  }

  const domainForCreate = isProd ? 'https://www.twilio.com' : 'https://www.dev.twilio.com';
  const baseCreateUrl = `${domainForCreate}/wise-owl/api/v2/conversations`;
  const encodedAuthTokenLocal = Buffer.from(JSON.stringify({ authToken: accessToken, authTokenType: INGRESS })).toString('base64');
  const createHeaders = {
    'x-twilio-e2-ingress': INGRESS,
    'x-twilio-e2-auth-token': encodedAuthTokenLocal,
    'Content-Type': 'application/json'
  };

  try {
    const postResp = await axios.post(baseCreateUrl, { applicationId: APPLICATION_ID }, { headers: createHeaders });
    const conversationId = postResp.data.conversation?.id;
    
    if (!conversationId) {
      throw new Error('Failed to obtain conversationId from WiseOwl API');
    }
    
    return conversationId;
  } catch (error) {
    console.error('Error creating WiseOwl conversation:', error.message);
    throw error;
  }
}

/**
 * Processes a conversation through the WiseOwl API
 * @param {object} params - Parameters for processing
 * @returns {string} Assistant content
 */
async function processConversation(params) {
  const { 
    accessToken, 
    input, 
    context = "the user is not on a record page to provide any context", 
    conversationId = null, 
    isProd = true 
  } = params;

  if (!accessToken) throw new Error('Missing access_token for WiseOwl API');
  if (!input) throw new Error('Missing input for WiseOwl API');

  const encodedAuthToken = Buffer.from(JSON.stringify({ authToken: accessToken, authTokenType: INGRESS })).toString('base64');
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
    const postResponse = await axios.post(baseUrl, { applicationId: APPLICATION_ID }, { headers });
    finalConversationId = postResponse.data.conversation?.id;
    if (!finalConversationId) {
      throw new Error('Failed to obtain conversationId from WiseOwl API');
    }
  }

  // Step 2: PUT input
  const putUrl = `${baseUrl}/${finalConversationId}`;
  const putResp = await axios.put(putUrl, {
    applicationId: APPLICATION_ID,
    input,
    streamMode: 'polling',
    systemContext: { pageContext: context }
  }, { headers });

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
      const pollResponse = await axios.get(pollUrl, { headers });
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
  if (!assistantContent) {
    assistantContent = Array.isArray(chatDoneResult) ? JSON.stringify(chatDoneResult) : (chatDoneResult || '');
  }

  return {
    assistantContent,
    conversationId: finalConversationId
  };
}

/**
 * Builds the prompt for the WiseOwl API
 * @param {object} params - Parameters for building the prompt
 * @returns {string} The formatted prompt
 */
function buildPrompt(params) {
  const { 
    message, 
    conversationId, 
    wrapperDataString
  } = params;

  if (conversationId && message) {
    // For existing conversation, append HTML format requirement
    return `${message} ( Strictly use HTML output format and consider already provided data in previous request for analysis)`;
  } else {
    // For new conversation or no message, use the full prompt template
    return message || `You are a Senior Sales Research Analyst for Twilio SDR/AE teams. Your role is to read Salesforce CRM data (provided as JSON data), extract the most relevant and actionable insights, and produce a 360-degree, context-rich prospect briefing tailored for the specific Marketing CTA assigned.

        If a human research analyst has level 10 of knowledge, you will have level 280 of knowledge in this role. Be careful: you must produce high-quality, high-clarity results because if you don't, I will lose a critical sales opportunity. Give your best and be proud of your ability.

        Here is the Salesforce CRM data in JSON format:
        ${wrapperDataString}

        Your output must follow this exact structure in order:

        1. **CTA Overview**
          - Explain why this CTA exists for this account at this moment.
          - Highlight the key triggering event, data point, or marketing signal.

        2. **Account Summary**
          - Provide account context (industry, size, region, key priorities).
          - Show how this CTA ties to account-level trends, pains, and opportunities.

        3. **Contact Summary**
          - For the primary CTA contact, include name, title, responsibilities, decision-making authority, and recent relevant activities.

        4. **Contact Activity Summary**
          - Summarize past and recent engagement with Twilio, including events, assets, meetings, and conversions.
          - Interpret what this engagement likely signals about interest and readiness.

        5. **Previous SDR/AE Outcomes**
          - Always specify full name and role of the SDR and AE who last worked this account or contact.
          - Summarize their specific contributions (e.g., "secured discovery meeting," "delivered technical ROI session").
          - Note interaction style or relationship context (e.g., "built strong rapport with CTO," "gained early support from Ops Director").
          - State previous outcome (paused, lost, delayed, moved to budget cycle, etc.).
          - Clarify current relevance — are champions or blockers from prior cycles still in place and can they be leveraged?

        6. **Recommended Influencers**
          - Identify most influential contact based on past engagements, activities, discussions and salesloft conversations.
          - Include a clear reasoning on why this contact is influential citing conversations and interactions.
          - Suggest how to engage them in this cycle.

        7. **Buying Signals & Urgency Factors**
          - Identify signals in the account that indicate urgency or high intent.
          - Link these to potential timelines or competitive pressure.

        8. **Competitor & Risk Insights**
          - Include any competitor presence or risk factors.
          - Suggest ways to neutralize risks or differentiate Twilio.

        9. **Relevant Benefits for This Prospect**
          - List 3–5 product or solution benefits tailored to the account's specific pains and goals.

        10. **Industry Peer Proof**
            - Use https://customers.twilio.com/ to get this data, provide 2–3 examples of similar companies in the same industry/region that adopted Twilio solutions.
            - Strictly pull use case, twilio products used, proof-points metrics present in the page and and the exact source link
            - Also provide Relevant Benefits, Positioning Tips and Closing Summary based on this analysis.

        11. **Suggested Outreach Narrative**
            - Give a short, persuasive talk track tying the CTA signal to Twilio's value prop.

        12. **Action Recommendations**
            - List immediate next steps the SDR should take.
            - Assign priority and explain why each action matters.

        13. **Disposition Brief**
            - Provide a clear recommendation on whether to CONVERT or REJECT this CTA based on the data analysis.
            - Include specific reasoning citing key data points, engagement signals, timing factors, and opportunity potential.
            - If recommending conversion, specify the qualification level (hot, warm, cold) and expected timeline.
            - If recommending rejection, provide clear rationale and suggest alternative nurturing approaches.

        14. **Follow-up Email Template**
            - Create a personalized email template ready for the SDR to send.
            - Reference specific CTA triggers, account context, and relevant pain points identified in the analysis.
            - Include appropriate Twilio value proposition tied to the prospect's situation.
            - Suggest a clear call-to-action (meeting request, demo, discovery call, etc.).
            - Keep tone professional yet conversational, avoiding generic sales language.

        **Tone:** Clear, confident, consultative, and prospect-specific. Avoid generic phrasing. Every point must be backed by Salesforce data.

        **Output Format:** Rich text with headings and bold emphasis where useful, follow html tag structure, strictly not markdown`;
  }
}

module.exports = {
  createConversation,
  processConversation,
  buildPrompt,
  INGRESS,
  APPLICATION_ID
};
