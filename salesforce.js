/**
 * Salesforce Integration Module
 * Handles all Salesforce API interactions using JSForce
 */
const jsforce = require('jsforce');

// SFDC instance URL (can be overridden via env var)
const SFDC_INSTANCE_URL = process.env.SFDC_INSTANCE_URL || 'https://twlo--full.sandbox.my.salesforce.com';

/**
 * Creates a Salesforce connection using JSForce
 * @param {string} token - Salesforce access token
 * @returns {object} JSForce connection object
 */
async function createSalesforceConnection(token) {
  try {
    const conn = new jsforce.Connection({
      instanceUrl: SFDC_INSTANCE_URL,
      accessToken: token
    });
    
    // Verify connection with a simple identity request
    await conn.identity();
    return conn;
  } catch (error) {
    console.error('Salesforce connection validation failed:', error.message);
    throw new Error(`Authentication failed: ${error.message}`);
  }
}

/**
 * Gets an FSR record by ID
 * @param {object} conn - JSForce connection
 * @param {string} recordId - FSR record ID
 * @returns {object} FSR record
 */
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
    return null;
  }
}

/**
 * Gets account records for an account ID
 * @param {object} conn - JSForce connection
 * @param {string} accountId - Account ID
 * @returns {Array} Account records
 */
async function getAccountRecords(conn, accountId) {
  try {
    const accounts = await conn.sobject('Account')
      .select('Name, Id, Industry, AnnualRevenue, Employee_Count__c, CreatedDate, Twilio_Account_Tier_Final__c')
      .where({ Id: accountId })
      .limit(1)
      .execute();
    
    return accounts;
  } catch (error) {
    console.error('Error fetching Account records:', error);
    return [];
  }
}

/**
 * Gets CTA records for an account
 * @param {object} conn - JSForce connection
 * @param {string} accountId - Account ID
 * @returns {Array} CTA records
 */
async function getCTARecords(conn, accountId) {
  try {
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
    return [];
  }
}

/**
 * Gets contact records for an account
 * @param {object} conn - JSForce connection
 * @param {string} accountId - Account ID
 * @returns {Array} Contact records
 */
async function getContactRecords(conn, accountId) {
  try {
    const contacts = await conn.sobject('Contact')
      .select('Name, Id, Title, Email, Phone, Last_FSR_Activity__c')
      .where({ AccountId: accountId })
      .execute();
    
    return contacts;
  } catch (error) {
    console.error('Error fetching Contact records:', error);
    return [];
  }
}

/**
 * Gets task records for an account
 * @param {object} conn - JSForce connection
 * @param {string} accountId - Account ID
 * @returns {Array} Task records
 */
async function getTaskRecords(conn, accountId) {
  try {
    const tasks = await conn.sobject('Task')
      .select('Id, Subject, ActivityDate, Description, CallDisposition, Owner.Name, Type, Who.Name, What.Name, Status, WhoId, WhatId')
      .where({ WhatId: accountId })
      .sort('-CreatedDate')
      .limit(50)
      .execute();
    
    return tasks;
  } catch (error) {
    console.error('Error fetching Task records:', error);
    return [];
  }
}

/**
 * Gets task records for a specific contact
 * @param {object} conn - JSForce connection
 * @param {string} contactId - Contact ID
 * @returns {Array} Task records
 */
async function getTasksForContact(conn, contactId) {
  if (!contactId) return [];
  
  try {
    const tasks = await conn.sobject('Task')
      .select('Id, Subject, ActivityDate, Description, CallDisposition, Owner.Name, Type, Who.Name, What.Name, Status')
      .where({ WhoId: contactId })
      .sort('-CreatedDate')
      .limit(25)
      .execute();
    
    return tasks;
  } catch (error) {
    console.error('Error fetching tasks for contact:', error);
    return [];
  }
}

/**
 * Gets opportunity records for an account
 * @param {object} conn - JSForce connection
 * @param {string} accountId - Account ID
 * @returns {Array} Opportunity records
 */
async function getOpportunityRecords(conn, accountId) {
  try {
    const opportunities = await conn.sobject('Opportunity')
      .select('Name, Amount, StageName, CloseDate, OwnerId, Owner.Name, Id')
      .where({ AccountId: accountId })
      .where('CreatedDate >= LAST_N_MONTHS:6')
      .sort('-CreatedDate')
      .limit(50)
      .execute();
    
    return opportunities;
  } catch (error) {
    console.error('Error fetching Opportunity records:', error);
    return [];
  }
}

/**
 * Gets opportunity contact roles for a primary contact
 * @param {object} conn - JSForce connection
 * @param {Array} opportunityIds - Array of opportunity IDs
 * @param {string} primaryContactId - Primary contact ID
 * @returns {Array} Opportunity records with contact roles
 */
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

/**
 * Gets Salesloft conversation records for an account
 * @param {object} conn - JSForce connection
 * @param {string} accountId - Account ID
 * @returns {Array} Salesloft conversation records
 */
async function getSalesloftConversationRecords(conn, accountId) {
  try {
    const conversations = await conn.sobject('Salesloft_Conversations__dlm')
      .select('accountid__c, attendeesdetails__c, createddate__c, DataSource__c, DataSourceObject__c, ' +
              'InternalOrganization__c, KQ_meetingid__c, meetingid__c, meetingsummary__c, meetingtranscript__c')
      .where({ accountid__c: accountId })
      .sort('-createddate__c')
      .limit(50)
      .execute();
    
    return conversations;
  } catch (error) {
    console.error('Error fetching Salesloft Conversation records:', error);
    return [];
  }
}

/**
 * Gets product summary for an account
 * @param {object} conn - JSForce connection
 * @param {string} accountId - Account ID
 * @returns {Array} Product records
 */
async function getProductSummary(conn, accountId) {
  try {
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

/**
 * Processes account data into a standardized format
 * @param {Array} accounts - Account records
 * @returns {Array} Processed account data
 */
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

/**
 * Processes contact data into a standardized format
 * @param {Array} contacts - Contact records
 * @param {string} primaryContactId - Primary contact ID
 * @returns {Array} Processed contact data
 */
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

/**
 * Processes CTA data into a standardized format
 * @param {Array} ctaRecords - CTA records
 * @param {string} currentCtaId - Current CTA ID
 * @returns {Array} Processed CTA data
 */
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

/**
 * Processes activity data into a standardized format
 * @param {Array} tasks - Task records
 * @returns {Array} Processed activity data
 */
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

/**
 * Processes opportunity data into a standardized format
 * @param {Array} opportunities - Opportunity records
 * @returns {Array} Processed opportunity data
 */
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

/**
 * Processes Salesloft data into a standardized format
 * @param {Array} salesloftRecords - Salesloft records
 * @returns {Array} Processed Salesloft data
 */
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

/**
 * Collects all CTA-related data for a record
 * @param {object} conn - JSForce connection
 * @param {string} recordId - FSR record ID
 * @returns {object} All collected and processed CTA data
 */
async function collectAllCTAData(conn, recordId) {
  try {
    // Get the base FSR record
    const fsr = await getFSRRecord(conn, recordId);
    if (!fsr || !fsr.Inquiry_Account__c) {
      console.log('No FSR record found or no account associated');
      return { 
        error: 'No FSR record found or no account associated',
        primaryContext: { primaryCTA: null, relatedContact: null, relatedOpportunities: [], contactActivities: [], contactConversations: [] },
        additionalCTAs: [],
        accountData: null,
        additionalContacts: [],
        accountLevelActivities: [],
        additionalOpportunities: [],
        additionalConversations: [],
        productSummaryWrapperResponse: []
      };
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
    
    // Get primary contact if it wasn't found in the account contacts
    let primaryContact = null;
    if (primaryContactId) {
      // Check if the primary contact is already in the contacts list
      const primaryInList = contacts.find(c => c.Id === primaryContactId);
      
      if (!primaryInList) {
        console.log(`Primary contact ${primaryContactId} not found in account contacts. Fetching directly...`);
        try {
          // Fetch the primary contact directly
          const primaryContacts = await conn.sobject('Contact')
            .select('Name, Id, Title, Email, Phone, Last_FSR_Activity__c')
            .where({ Id: primaryContactId })
            .execute();
            
          if (primaryContacts && primaryContacts.length > 0) {
            primaryContact = primaryContacts[0];
            // Add this contact to our contacts list
            contacts.push(primaryContact);
            console.log(`Successfully fetched primary contact: ${primaryContact.Name}`);
          } else {
            console.log(`Could not find primary contact with ID ${primaryContactId}`);
          }
        } catch (error) {
          console.error(`Error fetching primary contact ${primaryContactId}:`, error);
        }
      }
    }
    
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

/**
 * Check for existing conversation record and create/update as needed
 * @param {object} conn - JSForce connection
 * @param {string} parentRecordId - FSR record ID
 * @param {string} conversationId - WiseOwl conversation ID
 * @returns {object} Record info with sfdcId and existing flag
 */
async function manageConversationRecord(conn, parentRecordId, conversationId) {
  const sfdcObject = process.env.SFDC_OBJECT_API_NAME || 'WO_Conversation__c';
  let sfdcId = null;
  let existingConversationId = null;
  let isExisting = false;

  try {
    // Check for existing record by Parent_Record_Id__c
    const queryResult = await conn.query(
      `SELECT Id, Conversation_Id__c FROM ${sfdcObject} WHERE Parent_Record_Id__c='${parentRecordId}' LIMIT 1`
    );
    
    if (queryResult.totalSize > 0) {
      const rec = queryResult.records[0];
      sfdcId = rec.Id;
      existingConversationId = rec.Conversation_Id__c || null;
      isExisting = true;
      console.log('Found existing conversation record:', existingConversationId);
    }
  } catch (qerr) {
    console.error('SOQL query failed:', qerr.message);
  }

  // If record exists but conversation ID doesn't, update it
  if (sfdcId && !existingConversationId && conversationId) {
    try {
      await conn.sobject(sfdcObject).update({
        Id: sfdcId,
        Conversation_Id__c: conversationId
      });
      existingConversationId = conversationId;
      console.log(`Updated existing record ${sfdcId} with conversation ID ${conversationId}`);
    } catch (updateError) {
      console.error('Failed to update record with conversation ID:', updateError.message);
    }
  }

  // If no record exists, create one
  if (!sfdcId && parentRecordId) {
    try {
      const createResult = await conn.sobject(sfdcObject).create({
        Conversation_Id__c: conversationId || null,
        Parent_Record_Id__c: parentRecordId,
        Chat_Done__c: false
      });
      
      if (createResult.success) {
        sfdcId = createResult.id;
        console.log(`Created new record with ID: ${sfdcId}`);
      } else {
        throw new Error(createResult.errors[0]?.message || 'Unknown error');
      }
    } catch (createError) {
      console.error('Failed to create record:', createError.message);
      throw createError;
    }
  }

  // Mark record as processing
  if (sfdcId) {
    try {
      await conn.sobject(sfdcObject).update({
        Id: sfdcId,
        Chat_Done__c: false,
        current_conversation__c: ''
      });
    } catch (updateErr) {
      console.error('Failed to mark record processing:', updateErr.message);
    }
  }

  return { 
    sfdcId, 
    existingConversationId,
    isExisting
  };
}

/**
 * Updates a conversation record with the LLM response
 * @param {object} conn - JSForce connection
 * @param {string} sfdcId - Record ID
 * @param {string} assistantContent - Content to add to the record
 */
async function updateConversationRecord(conn, sfdcId, assistantContent) {
  if (!conn || !sfdcId || !assistantContent) {
    console.error('Missing required parameters for updateConversationRecord');
    return;
  }

  const sfdcObject = process.env.SFDC_OBJECT_API_NAME || 'WO_Conversation__c';

  try {
    // Fetch current record to get Conversation_History__c
    const recordResult = await conn.sobject(sfdcObject).retrieve(sfdcId);
    const currentHistory = recordResult?.Conversation_History__c || '';

    // Simple HTML escape
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
      // Attempt to insert into existing <ul> if present, else append new ul
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

    console.log(`Updated conversation record ${sfdcId} with new content`);
  } catch (error) {
    console.error('Error updating conversation record:', error);
  }
}

module.exports = {
  createSalesforceConnection,
  getFSRRecord,
  getAccountRecords,
  getCTARecords,
  getContactRecords,
  getTaskRecords,
  getTasksForContact,
  getOpportunityRecords,
  getOpportunityContactRoles,
  getSalesloftConversationRecords,
  getProductSummary,
  processAccountData,
  processContactData,
  processCTAData,
  processActivityData,
  processOpportunityData,
  processSalesloftData,
  collectAllCTAData,
  manageConversationRecord,
  updateConversationRecord
};
