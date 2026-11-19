
'use strict';

const crypto = require('node:crypto');
const express = require('express');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 10000;

// ========================================
// ENVIRONMENT VARIABLES
// ========================================

const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const APP_SECRET = process.env.META_APP_SECRET;
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v27.0';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

const requiredVariables = {
  WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
  META_APP_SECRET: APP_SECRET,
  WHATSAPP_ACCESS_TOKEN: WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID: PHONE_NUMBER_ID,
  OPENAI_API_KEY
};

const missingVariables = Object.entries(requiredVariables)
  .filter(([, value]) => !value)
  .map(([name]) => name);

// ========================================
// HEALTH CHECK
// ========================================

app.get('/health', (req, res) => {
  res.status(200).json({
    status: missingVariables.length ? 'needs_configuration' : 'ok',
    service: 'whatsapp-ai-agent',
    missingEnvironmentVariables: missingVariables,
    wabaConfigurationPresent: Boolean(WABA_ID),
    adminConfigurationPresent: Boolean(ADMIN_API_SECRET)
  });
});

// ========================================
// ADMIN AUTHENTICATION
// ========================================

function verifyAdmin(req, res, next) {
  const authorization = req.headers.authorization || '';

  const suppliedSecret = authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : '';

  if (!ADMIN_API_SECRET || !suppliedSecret) {
    return res.status(401).json({
      error: 'Unauthorized'
    });
  }

  const supplied = Buffer.from(suppliedSecret);
  const expected = Buffer.from(ADMIN_API_SECRET);

  if (
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(supplied, expected)
  ) {
    return res.status(401).json({
      error: 'Invalid admin secret'
    });
  }

  next();
}

// ========================================
// CHECK WABA SUBSCRIPTION
// ========================================

app.get('/admin/subscribed-apps', verifyAdmin, async (req, res) => {
  try {
    if (!WABA_ID || !WHATSAPP_TOKEN) {
      return res.status(500).json({
        error: 'WABA ID or WhatsApp access token is missing'
      });
    }

    const url =
      `https://graph.facebook.com/${GRAPH_VERSION}/` +
      `${WABA_ID}/subscribed_apps`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`
      }
    });

    const result = await response.json();

    console.log('WABA SUBSCRIPTION CHECK STATUS:', response.status);

    if (!response.ok) {
      console.error('WABA CHECK ERROR:', result);
    }

    return res.status(response.status).json(result);

  } catch (error) {
    console.error('WABA SUBSCRIPTION CHECK ERROR:', error.message);

    return res.status(500).json({
      error: 'Unable to check WABA subscription'
    });
  }
});

// ========================================
// SUBSCRIBE WABA TO APP WEBHOOKS
// ========================================

app.post('/admin/subscribe-webhooks', verifyAdmin, async (req, res) => {
  try {
    if (!WABA_ID || !WHATSAPP_TOKEN) {
      return res.status(500).json({
        error: 'WABA ID or WhatsApp access token is missing'
      });
    }

    const url =
      `https://graph.facebook.com/${GRAPH_VERSION}/` +
      `${WABA_ID}/subscribed_apps`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`
      }
    });

    const result = await response.json();

    console.log('WABA SUBSCRIPTION REQUEST STATUS:', response.status);

    if (!response.ok) {
      console.error('WABA SUBSCRIPTION ERROR:', result);
      return res.status(response.status).json(result);
    }

    console.log('WABA SUBSCRIPTION REQUEST SUCCESSFUL');

    return res.status(200).json({
      status: 'success',
      message: 'WABA subscribed to app webhooks',
      metaResponse: result
    });

  } catch (error) {
    console.error('WABA SUBSCRIPTION ERROR:', error.message);

    return res.status(500).json({
      error: 'Unable to subscribe WABA to webhooks'
    });
  }
});

// ========================================
// META WEBHOOK VERIFICATION
// ========================================

app.get('/webhook', (req, res) => {
  console.log('META WEBHOOK VERIFICATION REQUEST RECEIVED');

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('META WEBHOOK VERIFICATION SUCCESSFUL');
    return res.status(200).send(challenge);
  }

  console.log('META WEBHOOK VERIFICATION FAILED');
  return res.sendStatus(403);
});

// ========================================
// EXTRACT WHATSAPP MESSAGE TEXT
// ========================================

function extractMessageText(message) {
  if (message.text?.body) {
    return message.text.body;
  }

  if (message.button?.text) {
    return message.button.text;
  }

  if (message.interactive?.button_reply?.title) {
    return message.interactive.button_reply.title;
  }

  if (message.interactive?.list_reply?.title) {
    return message.interactive.list_reply.title;
  }

  return '';
}

// ========================================
// VERIFY META SIGNATURE
// ========================================

function verifySignature(rawBody, signature) {
  if (!APP_SECRET || !signature || !Buffer.isBuffer(rawBody)) {
    return false;
  }

  const expected =
    'sha256=' +
    crypto
      .createHmac('sha256', APP_SECRET)
      .update(rawBody)
      .digest('hex');

  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(signature);

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

// ========================================
// GENERATE AI RESPONSE
// ========================================

async function generateAIReply(userMessage) {
  if (!openai) {
    throw new Error('OPENAI_API_KEY is missing');
  }

  const response = await openai.responses.create({
    model: OPENAI_MODEL,

    instructions:
      'You are the official WhatsApp customer support assistant for ' +
      'One Stop Electronics Hub. ' +
      'You communicate fluently in English and Kiswahili. ' +
      'Respond in the language used by the customer. ' +
      'Help customers with electronics, products, availability, ' +
      'prices and general enquiries. ' +
      'Be polite, helpful and concise. ' +
      'Never invent product prices, stock availability or business details. ' +
      'If you do not know something, ask the customer to contact the business.',

    input: userMessage
  });

  return response.output_text ||
    'Samahani, sijaweza kupata jibu kwa sasa. Tafadhali jaribu tena.';
}

// ========================================
// SEND WHATSAPP MESSAGE
// ========================================

async function sendWhatsAppMessage(to, message) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    throw new Error('WhatsApp environment variables are missing');
  }

  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/` +
    `${PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: 'POST',

    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },

    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: {
        preview_url: false,
        body: message
      }
    })
  });

  const result = await response.json();

  if (!response.ok) {
    console.error('WHATSAPP API ERROR:', response.status, result);

    throw new Error(
      `WhatsApp API returned HTTP ${response.status}`
    );
  }

  console.log('WHATSAPP MESSAGE SENT SUCCESSFULLY');
  console.log('WhatsApp message ID:', result.messages?.[0]?.id);

  return result;
}

// ========================================
// PROCESS INCOMING WHATSAPP MESSAGES
// ========================================

async function processWebhook(payload) {
  try {
    console.log('PROCESSING WEBHOOK PAYLOAD');

    if (payload.object !== 'whatsapp_business_account') {
      console.log('Ignoring non-WhatsApp webhook object');
      return;
    }

    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {

        if (change.field !== 'messages') {
          console.log('Ignoring webhook field:', change.field);
          continue;
        }

        const messages = change.value?.messages || [];

        console.log('Incoming message count:', messages.length);

        for (const message of messages) {

          if (!message.from) {
            continue;
          }

          const sender = message.from;
          const userMessage = extractMessageText(message);

          console.log('INCOMING WHATSAPP MESSAGE RECEIVED');
          console.log('Message type:', message.type);
          console.log('Message ID:', message.id);

          if (!userMessage.trim()) {
            console.log('Message has no supported text content');
            continue;
          }

          console.log('GENERATING AI RESPONSE');

          const aiReply = await generateAIReply(userMessage);

          console.log('AI RESPONSE GENERATED');

          await sendWhatsAppMessage(sender, aiReply);
        }
      }
    }

  } catch (error) {
    console.error('WEBHOOK PROCESSING ERROR:', error);
  }
}

// ========================================
// RECEIVE META WEBHOOK NOTIFICATIONS
// ========================================

app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {

    console.log('======================================');
    console.log('META WEBHOOK POST RECEIVED');
    console.log('Time:', new Date().toISOString());
    console.log(
      'Signature header present:',
      Boolean(req.headers['x-hub-signature-256'])
    );
    console.log('======================================');

    if (!Buffer.isBuffer(req.body)) {
      console.error('Webhook body is not a raw Buffer');
      return res.sendStatus(400);
    }

    const signature = req.headers['x-hub-signature-256'];

    if (!verifySignature(req.body, signature)) {
      console.error('META SIGNATURE VERIFICATION FAILED');
      return res.sendStatus(401);
    }

    console.log('META SIGNATURE VERIFIED');

    let payload;

    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch (error) {
      console.error('INVALID WEBHOOK JSON:', error.message);
      return res.sendStatus(400);
    }

    console.log('Webhook object:', payload.object);

    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        console.log('Webhook field:', change.field);
      }
    }

    // Acknowledge Meta immediately.
    res.sendStatus(200);

    // Process the event in the background.
    processWebhook(payload).catch(error => {
      console.error('BACKGROUND WEBHOOK ERROR:', error);
    });
  }
);

// ========================================
// ROOT ENDPOINT
// ========================================

app.get('/', (req, res) => {
  res.status(200).send('WhatsApp AI Agent is running.');
});

// ========================================
// START SERVER
// ========================================

app.listen(PORT, '0.0.0.0', () => {

  console.log('======================================');
  console.log(`WhatsApp AI webhook listening on port ${PORT}`);
  console.log('Webhook endpoint: /webhook');
  console.log('Health endpoint: /health');
  console.log('WABA subscription check: /admin/subscribed-apps');
  console.log('WABA subscription action: /admin/subscribe-webhooks');

  if (missingVariables.length) {
    console.error(
      'MISSING ENVIRONMENT VARIABLES:',
      missingVariables.join(', ')
    );
  } else {
    console.log('Required environment variables are present.');
  }

  if (!WABA_ID) {
    console.warn('WABA ID is not configured.');
  }

  if (!ADMIN_API_SECRET) {
    console.warn('ADMIN API SECRET is not configured.');
  }

  console.log('======================================');
});
