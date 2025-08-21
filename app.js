const express = require('express');
const axios = require('axios');
const jsforce = require('jsforce'); // Add jsforce for Salesforce API
const app = express();

// Constants
const INGRESS = "SALESFORCE";
const APPLICATION_ID = "wiseowl-salesforce-application";
// SFDC instance URL (can be overridden via env var)
const SFDC_INSTANCE_URL = process.env.SFDC_INSTANCE_URL || 'https://twlo--full.sandbox.my.salesforce.com';

// Middleware to parse JSON bodies
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Salesforce connection helper
async function createSalesforceConnection(token) {
  const conn = new jsforce.Connection({
    instanceUrl: SFDC_INSTANCE_URL,
    accessToken: token
  });
  return conn;
}

// Data collection functions
async function getFSRRecord(conn, recordId) {
  try {
    const record = await conn.sobject('FSR__c')
      .select('Id, Name, Inquiry_Account__c, contact__c')
      .where({ Id: recordId })
      .limit(1)
      .execute();
    
    return record[0];
  } catch (error) {
    console.error('Error fetching FSR record:', error);
    throw error;
  }
}

async function getAccountRecords(conn, accountId) {
  try {
    // Query fields from the updated Apex class
    const accounts = await conn.sobject('Account')
      .select('Name, Id, Industry, AnnualRevenue, Employee_Count__c, CreatedDate, Twilio_Account_Tier_Final__c')
      .where({ Id: accountId })
      .limit(1)
      .execute();
    
    return accounts;
  } catch (error) {
    console.error('Error fetching Account records:', error);
    throw error;
  }
}

async function getCTARecords(conn, accountId) {
  try {
    // Query fields from the updated Apex class
    const records = await conn.sobject('FSR__c')
      .select('Id, Name, inquiry_account__c, contact__c, OwnerId, product_category__c, Current_Interested_Product_Score_Grade__c, ' +
              'campaign__r.Name, Inquiry_Volume__c, MQL_Status__c, Owner.Name, inquiry_account__r.Name, inquiry_account__r.Industry, ' +
              'inquiry_account__r.AnnualRevenue, inquiry_account__r.NumberOfEmployees, inquiry_account__r.CreatedDate, ' +
              'contact__r.Name, contact__r.Title, contact__r.Email, contact__r.Phone, contact__r.LastActivityDate')
      .where({ inquiry_account__c: accountId, MQL_Status__c: { $ne: '1 - Open' } })
      .execute();
    
    return records;
  } catch (error) {
    console.error('Error fetching CTA records:', error);
    throw error;
  }
}

async function getContactRecords(conn, accountId) {
  try {
    // Query fields from the updated Apex class
    const contacts = await conn.sobject('Contact')
      .select('Name, Id, Title, Email, Phone, Last_FSR_Activity__c')
      .where({ AccountId: accountId })
      .execute();
    
    return contacts;
  } catch (error) {
    console.error('Error fetching Contact records:', error);
    throw error;
  }
}

async function getTaskRecords(conn, accountId) {
  try {
    // Query fields from the updated Apex class
    const tasks = await conn.sobject('Task')
      .select('Id, Subject, ActivityDate, Description, CallDisposition, Owner.Name, Type, Who.Name, What.Name, Status, WhoId, WhatId')
      .where({ WhatId: accountId })
      .sort('CreatedDate DESC')
      .limit(50)
      .execute();
    
    return tasks;
  } catch (error) {
    console.error('Error fetching Task records:', error);
    throw error;
  }
}

async function getTasksForContact(conn, contactId) {
  if (!contactId) return [];
  
  try {
    // Query tasks specifically for the primary contact as done in the Apex class
    const tasks = await conn.sobject('Task')
      .select('Id, Subject, ActivityDate, Description, CallDisposition, Owner.Name, Type, Who.Name, What.Name, Status')
      .where({ WhoId: contactId })
      .sort('CreatedDate DESC')
      .limit(25)
      .execute();
    
    return tasks;
  } catch (error) {
    console.error('Error fetching tasks for contact:', error);
    return [];
  }
}

async function getOpportunityRecords(conn, accountId) {
  try {
    // Query fields from the updated Apex class
    const opportunities = await conn.sobject('Opportunity')
      .select('Name, Amount, StageName, CloseDate, OwnerId, Owner.Name, Id')
      .where({ AccountId: accountId, CreatedDate: { $gt: { $literal: 'LAST_N_MONTHS:6' } } })
      .sort('CreatedDate DESC')
      .limit(50)
      .execute();
    
    return opportunities;
  } catch (error) {
    console.error('Error fetching Opportunity records:', error);
    throw error;
  }
}

async function getOpportunityContactRoles(conn, opportunityIds, primaryContactId) {
  if (!opportunityIds || opportunityIds.length === 0 || !primaryContactId) return [];
  
  try {
    const opportunities = await conn.sobject('Opportunity')
      .select('Id, (SELECT ContactId FROM OpportunityContactRoles WHERE ContactId = \'' + primaryContactId + '\')')
      .where({ Id: { $in: opportunityIds } })
      .limit(50)
      .execute();
    
    return opportunities;
  } catch (error) {
    console.error('Error fetching opportunity contact roles:', error);
    return [];
  }
}

async function getSalesloftConversationRecords(conn, accountId) {
  try {
    // Query fields from the updated Apex class
    const conversations = await conn.sobject('Salesloft_Conversations__dlm')
      .select('accountid__c, attendeesdetails__c, createddate__c, DataSource__c, DataSourceObject__c, ' +
              'InternalOrganization__c, KQ_meetingid__c, meetingid__c, meetingsummary__c, meetingtranscript__c')
      .where({ accountid__c: accountId })
      .sort('createddate__c DESC')
      .limit(50)
      .execute();
    
    return conversations;
  } catch (error) {
    console.error('Error fetching Salesloft Conversation records:', error);
    throw error;
  }
}

async function getProductSummary(conn, accountId) {
  try {
    // Query exact fields from the Apex class
    const products = await conn.query(
      `SELECT Id, Name, Product2Id, Product2.Name, Product2.Family, Product2.Description, 
             OpportunityId, Opportunity.Name, Opportunity.StageName, Opportunity.CloseDate,
             Quantity, UnitPrice, TotalPrice, Description
      FROM OpportunityLineItem 
      WHERE Opportunity.AccountId = '${accountId}'
      ORDER BY Opportunity.CloseDate DESC, CreatedDate DESC`
    );
    
    return products.records;
  } catch (error) {
    console.error('Error fetching Product Summary:', error);
    return [];
  }
}

// Process and organize data - Match Apex class structure
function processAccountData(accounts) {
  if (!accounts || accounts.length === 0) return null;
  
  return accounts.map(account => ({
    accountId: account.Id,
    accountName: account.Name,
    industry: account.Industry,
    annualRevenue: account.AnnualRevenue ? String(account.AnnualRevenue) : null,
    employeeCount: account.Employee_Count__c ? Number(account.Employee_Count__c) : null,
    // Fields for UI
    accountLink: '/' + account.Id,
    customerSince: account.CreatedDate ? String(account.CreatedDate) : null,
    healthScore: account.Twilio_Account_Tier_Final__c
  }));
}

function processContactData(contacts, primaryContactId) {
  if (!contacts || contacts.length === 0) return [];
  
  let hasPrimary = false;
  
  const contactDataList = contacts.map(contact => {
    const isPrimary = contact.Id === primaryContactId;
    if (isPrimary) hasPrimary = true;
    
    return {
      contactId: contact.Id,
      contactName: contact.Name,
      title: contact.Title,
      email: contact.Email,
      phone: contact.Phone,
      isPrimary: isPrimary,
      // UI fields
      contactLink: '/' + contact.Id,
      lastContact: contact.Last_FSR_Activity__c ? String(contact.Last_FSR_Activity__c) : null
    };
  });
  
  // If no primary contact found and we have contacts, mark first as primary
  if (!hasPrimary && contactDataList.length > 0) {
    contactDataList[0].isPrimary = true;
  }
  
  return contactDataList;
}

function processCTAData(ctaRecords, currentCtaId) {
  if (!ctaRecords || ctaRecords.length === 0) return [];
  
  return ctaRecords.map(cta => ({
    ctaName: cta.Name,
    recordId: cta.Id,
    isPrimary: cta.Id === currentCtaId,
    ctaInquiryAccountName: cta.inquiry_account__r?.Name,
    ownerName: cta.Owner?.Name,
    // Additional UI fields
    product: cta.product_category__c,
    scoreGrade: cta.Current_Interested_Product_Score_Grade__c,
    campaign: cta.campaign__r?.Name,
    expectedRevenue: cta.Inquiry_Volume__c ? String(cta.Inquiry_Volume__c) : null,
    status: cta.MQL_Status__c
  }));
}

function processActivityData(tasks) {
  if (!tasks || tasks.length === 0) return [];
  
  return tasks.map(task => ({
    id: task.Id,
    activityType: task.Type,
    activityDate: task.ActivityDate,
    description: task.Description,
    outcome: task.CallDisposition,
    contactPerson: task.Who?.Name,
    ownerName: task.Owner?.Name,
    // Additional UI fields
    type: task.Type,
    subject: task.Subject
  }));
}

function processOpportunityData(opportunities) {
  if (!opportunities || opportunities.length === 0) return [];
  
  return opportunities.map(opp => {
    // Set status based on stage name
    let status = opp.StageName;
    if (opp.StageName && opp.StageName.includes('Won')) {
      status = 'Won';
    } else if (opp.StageName && opp.StageName.includes('Lost')) {
      status = 'Lost';
    }
    
    // Format amount for display
    const formattedAmount = opp.Amount ? '$' + Number(opp.Amount).toLocaleString() : null;
    
    // Format date for display
    const formattedDate = opp.CloseDate ? new Date(opp.CloseDate).toLocaleDateString() : null;
    
    return {
      id: opp.Id,
      name: opp.Name,
      amount: opp.Amount,
      stageName: opp.StageName,
      closedDate: opp.CloseDate,
      ownerName: opp.Owner?.Name,
      // UI fields
      status: status,
      formattedAmount: formattedAmount,
      formattedDate: formattedDate,
      isRelatedToPrimaryContact: false // Will be set during organization phase
    };
  });
}

function processSalesloftData(salesloftRecords) {
  if (!salesloftRecords || salesloftRecords.length === 0) return [];
  
  return salesloftRecords.map(record => {
    // Format date for display
    const formattedDate = record.createddate__c ? 
      new Date(record.createddate__c).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric' }) : 
      null;
    
    // Count attendees if details are available
    let attendeeCount = 'N/A';
    if (record.attendeesdetails__c) {
      try {
        if (record.attendeesdetails__c.includes(',')) {
          attendeeCount = String(record.attendeesdetails__c.split(',').length);
        } else if (record.attendeesdetails__c.includes('[')) {
          // If it's JSON array, try to parse
          try {
            const attendees = JSON.parse(record.attendeesdetails__c);
            if (Array.isArray(attendees)) {
              attendeeCount = String(attendees.length);
            }
          } catch (e) {
            attendeeCount = '1';
          }
        } else {
          attendeeCount = '1';
        }
      } catch (e) {
        attendeeCount = 'N/A';
      }
    }
    
    // Create summary preview
    let summaryPreview = '';
    if (record.meetingsummary__c) {
      summaryPreview = record.meetingsummary__c.length > 150 ? 
        record.meetingsummary__c.substring(0, 150) + '...' : 
        record.meetingsummary__c;
    }
    
    return {
      accountId: record.accountid__c,
      attendeesDetails: record.attendeesdetails__c,
      createdDate: record.createddate__c,
      dataSource: record.DataSource__c,
      dataSourceObject: record.DataSourceObject__c,
      internalOrganization: record.InternalOrganization__c,
      kqMeetingId: record.KQ_meetingid__c,
      meetingId: record.meetingid__c,
      meetingSummary: record.meetingsummary__c,
      meetingTranscript: record.meetingtranscript__c,
      // UI fields
      formattedDate: formattedDate,
      attendeeCount: attendeeCount,
      summaryPreview: summaryPreview
    };
  });
}

async function collectAllCTAData(conn, recordId) {
  try {
    // Get the base FSR record
    const fsr = await getFSRRecord(conn, recordId);
    if (!fsr || !fsr.Inquiry_Account__c) {
      return { error: 'No FSR record found or no account associated' };
    }
    
    const accountId = fsr.Inquiry_Account__c;
    const primaryContactId = fsr.contact__c;
    
    // Fetch all data in parallel for better performance
    const [
      accounts,
      ctaRecords,
      contacts,
      accountTasks,
      opportunities,
      salesloftConversations,
      productSummary
    ] = await Promise.all([
      getAccountRecords(conn, accountId),
      getCTARecords(conn, accountId),
      getContactRecords(conn, accountId),
      getTaskRecords(conn, accountId),
      getOpportunityRecords(conn, accountId),
      getSalesloftConversationRecords(conn, accountId),
      getProductSummary(conn, accountId)
    ]);
    
    // Also get tasks for the primary contact if available
    let contactTasks = [];
    if (primaryContactId) {
      contactTasks = await getTasksForContact(conn, primaryContactId);
    }
    
    // Process data
    const contactDataList = processContactData(contacts, primaryContactId);
    const ctaDataList = processCTAData(ctaRecords, recordId);
    const accountTasksData = processActivityData(accountTasks);
    const contactTasksData = processActivityData(contactTasks);
    const opportunityDataList = processOpportunityData(opportunities);
    const salesloftDataList = processSalesloftData(salesloftConversations);
    
    // Organize data into hierarchical structure matching Apex class
    const allData = {
      primaryContext: {
        primaryCTA: ctaDataList.find(cta => cta.isPrimary) || null,
        relatedContact: contactDataList.find(contact => contact.isPrimary) || null,
        relatedOpportunities: [],
        contactActivities: contactTasksData,
        contactConversations: []
      },
      additionalCTAs: ctaDataList.filter(cta => !cta.isPrimary),
      accountData: processAccountData(accounts)[0],
      additionalContacts: contactDataList.filter(contact => !contact.isPrimary),
      accountLevelActivities: accountTasksData,
      additionalOpportunities: opportunityDataList,
      additionalConversations: salesloftDataList,
      productSummaryWrapperResponse: productSummary
    };
    
    // If we have opportunity data and a primary contact, find related opportunities
    if (primaryContactId && opportunityDataList.length > 0) {
      const opportunityIds = opportunityDataList.map(opp => opp.id);
      if (opportunityIds.length > 0) {
        try {
          // Get opportunity contact roles to determine which opportunities are related to primary contact
          const oppsWithRoles = await getOpportunityContactRoles(conn, opportunityIds, primaryContactId);
          if (oppsWithRoles && oppsWithRoles.length > 0) {
            // Map of opportunity IDs that have the primary contact as a contact role
            const primaryContactOpps = new Set();
            oppsWithRoles.forEach(opp => {
              if (opp.OpportunityContactRoles && opp.OpportunityContactRoles.records.length > 0) {
                primaryContactOpps.add(opp.Id);
              }
            });
            
            // Separate opportunities related to primary contact
            opportunityDataList.forEach(opp => {
              if (primaryContactOpps.has(opp.id)) {
                opp.isRelatedToPrimaryContact = true;
                allData.primaryContext.relatedOpportunities.push(opp);
              } else {
                allData.additionalOpportunities.push(opp);
              }
            });
          }
        } catch (error) {
          console.error('Error processing opportunity contact roles:', error);
          allData.additionalOpportunities = opportunityDataList;
        }
      }
    } else {
      allData.additionalOpportunities = opportunityDataList;
    }
    
    // Organize Salesloft conversations - add to primary context if they mention primary contact name
    if (allData.primaryContext.relatedContact && allData.primaryContext.relatedContact.contactName) {
      const primaryContactName = allData.primaryContext.relatedContact.contactName;
      allData.primaryContext.contactConversations = salesloftDataList.filter(conv => 
        conv.attendeesDetails && conv.attendeesDetails.toLowerCase().includes(primaryContactName.toLowerCase())
      );
      
      // Remove these from additional conversations
      const primaryConvIds = new Set(allData.primaryContext.contactConversations.map(conv => 
        conv.meetingId || conv.kqMeetingId
      ));
      
      allData.additionalConversations = salesloftDataList.filter(conv => 
        !primaryConvIds.has(conv.meetingId) && !primaryConvIds.has(conv.kqMeetingId)
      );
    }
    
    return allData;
  } catch (error) {
    console.error('Error collecting CTA data:', error);
    throw error;
  }
}

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

    const sfdcObject = process.env.SFDC_OBJECT_API_NAME || 'WO_Conversation__c';

    // Create Salesforce connection using jsforce
    let conn;
    try {
      conn = await createSalesforceConnection(sfdcToken);
    } catch (connError) {
      console.error('Failed to create Salesforce connection:', connError.message);
      return res.status(500).json({ error: 'Failed to connect to Salesforce', message: connError.message });
    }

    // Check for existing record by Parent_Record_Id__c
    let sfdcId = null;
    let existingConversationId = null;

    try {
      const queryResult = await conn.query(`SELECT Id, Conversation_Id__c FROM ${sfdcObject} WHERE Parent_Record_Id__c='${parentRecordId}' LIMIT 1`);
      
      if (queryResult.totalSize > 0) {
        const rec = queryResult.records[0];
        sfdcId = rec.Id;
        existingConversationId = rec.Conversation_Id__c || null;
        console.log('Using existing conversation:', existingConversationId);
      }
    } catch (qerr) {
      // Query failed; continue to create new record
      console.error('SOQL query failed:', qerr.message);
    }

    // Determine or initialize conversationId to use
    let conversationIdToUse = existingConversationId || null;

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

      const postResp = await axios.post(baseCreateUrl, { applicationId: APPLICATION_ID }, { headers: createHeaders });
      conversationIdToUse = postResp.data.conversation?.id;

      if (!conversationIdToUse) {
        return res.status(500).json({ error: 'Failed to initialize conversation' });
      }

      // If record exists, update it to set Conversation_Id__c using jsforce
      if (sfdcId) {
        try {
          await conn.sobject(sfdcObject).update({
            Id: sfdcId,
            Conversation_Id__c: conversationIdToUse
          });
        } catch (updateError) {
          console.error('Failed to update record with conversation ID:', updateError.message);
        }
      }
    }

    if (!sfdcId) {
      // Create new record with conversation id using jsforce
      try {
        const createResult = await conn.sobject(sfdcObject).create({
          Conversation_Id__c: conversationIdToUse || null,
          Parent_Record_Id__c: parentRecordId,
          Chat_Done__c: false
        });
        
        if (createResult.success) {
          sfdcId = createResult.id;
          console.log(`Created new record with ID: ${sfdcId}`);
        } else {
          console.error('Failed to create record:', createResult.errors);
          return res.status(500).json({ error: 'Failed to create Salesforce record', message: createResult.errors[0]?.message || 'Unknown error' });
        }
      } catch (createError) {
        console.error('Failed to create record:', createError.message);
        return res.status(500).json({ error: 'Failed to create Salesforce record', message: createError.message });
      }
    }

    // Ensure record is marked as processing (Chat_Done__c = false) and clear current_conversation__c
    try {
      await conn.sobject(sfdcObject).update({
        Id: sfdcId,
        Chat_Done__c: false, 
        current_conversation__c: ''
      });
    } catch (updateErr) {
      console.error('Failed to mark record processing:', updateErr.message);
    }

    // Return the Salesforce record id immediately to the caller
    res.status(201).json({ recordId: sfdcId });

    // Start async processing in background (don't await)
    (async () => {
      try {
        // Create Salesforce connection for processing
        const conn = await createSalesforceConnection(sfdcToken);
        
        // Collect CTA data
        let ctaData = {};
        try {
          ctaData = await collectAllCTAData(conn, recordId);
          console.log('Successfully collected CTA data for background job');
        } catch (dataError) {
          console.error('Error collecting CTA data:', dataError);
          // Continue with empty CTA data
        }
        
        // Stringify the data for use in the prompt
        const wrapperDataString = JSON.stringify(ctaData, null, 2);
        
        // Set input message format based on whether this is a new conversation or existing one
        let input;
        if (conversationIdToUse && message) {
          // For existing conversation, append HTML format requirement
          input = `${message} ( Strictly use HTML output format and consider already provided data in previous request for analysis)`;
        } else {
          // For new conversation or no message, use the full prompt template
        input = message || `You are a Senior Sales Research Analyst for Twilio SDR/AE teams. Your role is to read Salesforce CRM data (provided as JSON data), extract the most relevant and actionable insights, and produce a 360-degree, context-rich prospect briefing tailored for the specific Marketing CTA assigned.

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
        
        await processJobAsync({
          sfdcId,
          conn,
          access_token,
          input,
          context: "the user is not on a record page to provide any context",
          conversationId: conversationIdToUse || null,
          isProd
        });
      } catch (bgErr) {
        console.error('Background job failed:', bgErr?.message || bgErr);
        // Optionally, patch SFDC record with failure info here
      }
    })();

  } catch (err) {
    console.error('Failed to create SFDC record:', err.message);
    res.status(500).json({ error: 'Failed to create SFDC record', message: err.message });
  }
});


// --- Worker functions (embedded) -----------------------------------------
// In-process async processor that performs the conversation flow and patches SFDC record
async function processJobAsync({ sfdcId, conn, access_token, input, context, conversationId, isProd }) {
  // Call the external conversation API flow (create conversation if needed, PUT input, poll for completion)
  console.log(`Processing background job for SFDC record ${sfdcId}`);

  if (!access_token) throw new Error('Missing access_token for conversation API');
  if (!conn) throw new Error('Salesforce connection not available');

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
    const postResponse = await axios.post(baseUrl, { applicationId: APPLICATION_ID }, { headers });
    finalConversationId = postResponse.data.conversation?.id;
  }

  if (!finalConversationId) throw new Error('Failed to obtain conversationId from external API');

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

  // Step 4: Update the WO_Conversation__c record using JSForce
  const sfdcObject = process.env.SFDC_OBJECT_API_NAME || 'WO_Conversation__c';

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

  // Fetch current record to get Conversation_History__c
  const recordResult = await conn.sobject(sfdcObject).retrieve(sfdcId);
  const currentHistory = recordResult?.Conversation_History__c || '';

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

  // Update the record using jsforce
  await conn.sobject(sfdcObject).update({
    Id: sfdcId,
    Conversation_History__c: newHistory,
    Chat_Done__c: true,
    current_conversation__c: assistantContent
  });

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
