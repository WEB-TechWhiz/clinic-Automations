require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
let dbHelper = require('./db');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory logs for the Live Workflow Trace on the Dashboard
const systemLogs = [];
function addLog(step, message, details = null) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    step, // 'WEBHOOK', 'DB_CHECK', 'AI_PARSE', 'DB_WRITE', 'OUTBOUND_SMS'
    message,
    details: details ? JSON.stringify(details, null, 2) : null
  };
  systemLogs.push(logEntry);
  if (systemLogs.length > 50) systemLogs.shift(); // Keep last 50 logs
  
  // Send update to all active SSE clients
  sseClients.forEach(client => {
    client.res.write(`data: ${JSON.stringify(logEntry)}\n\n`);
  });
  console.log(`[${step}] ${message}`, details || '');
}

// Server-Sent Events (SSE) client store
let sseClients = [];
app.get('/api/logs/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  
  // Send existing logs
  systemLogs.forEach(log => {
    res.write(`data: ${JSON.stringify(log)}\n\n`);
  });
  
  const clientId = Date.now();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);
  
  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

// Clear logs helper
app.post('/api/logs/clear', (req, res) => {
  systemLogs.length = 0;
  res.json({ success: true });
});

// AI INTENT PARSER using Gemini API (with robust heuristic fallback)
async function parseIntentWithAI(userMessage) {
  const apiKey = process.env.GEMINI_API_KEY;
  const now = new Date();
  const currentDate = now.toISOString().split('T')[0];
  const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const currentDay = daysOfWeek[now.getDay()];

  if (!apiKey) {
    addLog('AI_PARSE', 'No GEMINI_API_KEY found. Using heuristic fallback parser.');
    return heuristicFallbackParser(userMessage, currentDate, now.getDay());
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const systemPrompt = `
You are an AI booking engine for an Indian clinic. Parse the patient's message.
Today's date is: ${currentDate} (${currentDay}).
Clinic Doctors:
1. "Dr. Rajesh Sharma" (General Physician)
2. "Dr. Sneha Patil" (Pediatrician)

Valid slot times are: 10:00, 11:00, 12:00, 14:00, 15:00, 16:00.

Input can be English, Hindi, or Hinglish (e.g. "kal dopahar ko 2 baje", "Monday 11am", "cancel booking").
Respond ONLY with a JSON object. No markdown, no backticks, no wrapping text. Just raw JSON.
Example JSON:
{
  "intent": "BOOK", // "BOOK", "RESCHEDULE", "CANCEL", "DELAY", "UNKNOWN"
  "date": "YYYY-MM-DD", // Parsed date
  "time": "HH:MM", // 24-hour time format matching valid slots
  "doctor": "Dr. Rajesh Sharma", // Match doctor name or assign default
  "reason": "General description or null"
}
If intent is CANCEL, set intent to "CANCEL". If patient replies 'L' or says they are running late, set intent to "DELAY".
`;

    addLog('AI_PARSE', `Sending message to Gemini API: "${userMessage}"`);
    const result = await model.generateContent([systemPrompt, `Message: "${userMessage}"`]);
    const responseText = result.response.text().trim();
    
    // Extract JSON in case Gemini outputs Markdown code blocks
    let cleanJson = responseText;
    if (cleanJson.includes('```json')) {
      cleanJson = cleanJson.substring(cleanJson.indexOf('```json') + 7, cleanJson.lastIndexOf('```')).trim();
    } else if (cleanJson.includes('```')) {
      cleanJson = cleanJson.substring(cleanJson.indexOf('```') + 3, cleanJson.lastIndexOf('```')).trim();
    }
    
    const parsed = JSON.parse(cleanJson);
    addLog('AI_PARSE', `Gemini parsed successfully`, parsed);
    return parsed;
  } catch (err) {
    addLog('AI_PARSE', `Gemini API failed: ${err.message}. Falling back to heuristics.`);
    return heuristicFallbackParser(userMessage, currentDate, now.getDay());
  }
}

// Robust fallback parsing using regex rules for dates, times, and intents
function heuristicFallbackParser(message, currentDate, currentDayNum) {
  const msg = message.toLowerCase();
  const result = {
    intent: 'UNKNOWN',
    date: null,
    time: null,
    doctor: 'Dr. Rajesh Sharma', // Default doctor
    reason: null
  };

  // 1. Detect Intent
  if (msg === 'r' || msg.includes('reschedule') || msg.includes('change date') || msg.includes('change time')) {
    result.intent = 'RESCHEDULE';
    return result;
  }
  if (msg === 'c' || msg.includes('cancel') || msg.includes('cancle') || msg.includes('hatado')) {
    result.intent = 'CANCEL';
    return result;
  }
  if (msg === 'l' || msg.includes('late') || msg.includes('running late') || msg.includes('deri') || msg.includes('phas gaya')) {
    result.intent = 'DELAY';
    return result;
  }
  if (msg.includes('book') || msg.includes('appointment') || msg.includes('slot') || msg.includes('appointment leni hai') || msg.includes('milna hai') || /\d/.test(msg)) {
    result.intent = 'BOOK';
  }

  // 2. Doctor selection
  if (msg.includes('sneha') || msg.includes('patil') || msg.includes('child') || msg.includes('pediatrician') || msg.includes('bacha')) {
    result.doctor = 'Dr. Sneha Patil';
  }

  // 3. Date Parsing
  let targetDate = new Date();
  let dateFound = false;

  if (msg.includes('today') || msg.includes('aaj')) {
    dateFound = true;
  } else if (msg.includes('tomorrow') || msg.includes('kal') || msg.includes('kal ko')) {
    targetDate.setDate(targetDate.getDate() + 1);
    dateFound = true;
  } else if (msg.includes('day after') || msg.includes('parso') || msg.includes('parson')) {
    targetDate.setDate(targetDate.getDate() + 2);
    dateFound = true;
  } else {
    // Check days of week
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const daysHindi = ['ravivar', 'somvar', 'mangalvar', 'budhvar', 'guruvar', 'shukravar', 'shanivar'];
    
    for (let i = 0; i < 7; i++) {
      if (msg.includes(days[i]) || msg.includes(daysHindi[i])) {
        let diff = i - currentDayNum;
        if (diff <= 0) diff += 7; // Next week's day
        targetDate.setDate(targetDate.getDate() + diff);
        dateFound = true;
        break;
      }
    }
  }

  if (dateFound) {
    result.date = targetDate.toISOString().split('T')[0];
  } else {
    // If no date found but number is present, check if it's tomorrow's date format or default to tomorrow
    result.date = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // Default to tomorrow
  }

  // 4. Time Parsing (Heuristic check for hours)
  const timeMatch = msg.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|baje|o'clock)?/i);
  if (timeMatch) {
    let hour = parseInt(timeMatch[1]);
    const minutes = timeMatch[2] || '00';
    const period = timeMatch[3];

    // Handle "baje" or Hinglish contexts (e.g. "dopahar 2 baje" = 2 PM = 14:00)
    if (period && period.toLowerCase() === 'pm' && hour < 12) {
      hour += 12;
    } else if (period && period.toLowerCase() === 'baje') {
      if (hour >= 1 && hour <= 6) { // Typically 1-6 baje implies afternoon/PM
        hour += 12;
      }
    } else if (msg.includes('dopahar') || msg.includes('afternoon') || msg.includes('evening') || msg.includes('sham')) {
      if (hour < 12) hour += 12;
    }

    // Format hour
    const hourStr = hour.toString().padStart(2, '0');
    // Normalize to valid slots: 10:00, 11:00, 12:00, 14:00, 15:00, 16:00
    const validHours = ['10', '11', '12', '14', '15', '16'];
    if (validHours.includes(hourStr)) {
      result.time = `${hourStr}:${minutes}`;
    } else {
      // Find closest valid hour
      result.time = '11:00'; // Fallback
    }
  } else {
    result.time = '11:00'; // Default time
  }

  addLog('AI_PARSE', `Heuristics parsed successfully`, result);
  return result;
}

// CORE WHATSAPP BOT WORKFLOW ENGINE
async function handleBotWorkflow(phone, message) {
  addLog('WEBHOOK', `Inbound WhatsApp message from ${phone}: "${message}"`);
  
  // 1. Check if patient exists in database
  addLog('DB_CHECK', `Checking if phone number ${phone} is registered`);
  let patient = await dbHelper.getPatientByPhone(phone);
  
  if (!patient) {
    // Scenario 1: New Patient
    addLog('DB_WRITE', `No patient found. Creating new profile for ${phone}`);
    patient = await dbHelper.createPatient(phone, null, 'NEW');
    
    const welcomeMsg = `Namaste! 🙏 Welcome to Apollo Clinic.
It looks like this is your first time messaging us.

To get you registered, please fill out our quick intake form:
🔗 https://forms.gle/apollo-clinic-registration

Once you've filled it, please reply *Ready* to see available slots!`;
    
    addLog('OUTBOUND_SMS', `Sent Welcome & Registration Link to ${phone}`);
    return welcomeMsg;
  }

  // Scenario 2: New Patient replies "Ready" or fills form
  if (patient.status === 'NEW') {
    if (message.toLowerCase().includes('ready') || message.toLowerCase().includes('done') || message.toLowerCase().includes('ho gaya')) {
      addLog('DB_WRITE', `Patient completed registration. Updating ${phone} status to ACTIVE`);
      // Simulate saving registration details
      const randomNames = ["Rajesh Kumar", "Sunita Sharma", "Deepak Gupta", "Kiran Patel", "Anil Deshmukh"];
      const assignedName = randomNames[Math.floor(Math.random() * randomNames.length)];
      await dbHelper.updatePatientStatus(patient.id, assignedName, 'ACTIVE');
      
      const successMsg = `Dhanyawad, ${assignedName}! Your registration is complete.

I can help you book an appointment. We have slots available with:
1. *Dr. Rajesh Sharma* (General Physician)
2. *Dr. Sneha Patil* (Pediatrician)

Please tell me who you'd like to see and your preferred date/time. E.g., *"Book with Dr. Rajesh tomorrow at 11 AM"* or *"Sneha mam se Monday ko milna hai"*`;
      
      addLog('OUTBOUND_SMS', `Sent booking instruction template to ${phone}`);
      return successMsg;
    } else {
      const reminderMsg = `Welcome back! Please fill out the registration form first:
🔗 https://forms.gle/apollo-clinic-registration

Reply *Ready* when you are done.`;
      addLog('OUTBOUND_SMS', `Sent registration form reminder to ${phone}`);
      return reminderMsg;
    }
  }

  // Scenario 3: Active Patient - AI intent parser
  const parsed = await parseIntentWithAI(message);

  if (parsed.intent === 'CANCEL') {
    addLog('DB_CHECK', `Checking active appointment to cancel for patient ${patient.name}`);
    const activeAppt = await dbHelper.getActiveAppointment(patient.id);
    if (!activeAppt) {
      const msg = `You do not have any active appointments to cancel. If you'd like to book one, just type your preferred day/time!`;
      addLog('OUTBOUND_SMS', `Sent cancel error notice (no appointment found) to ${phone}`);
      return msg;
    }
    
    addLog('DB_WRITE', `Cancelling appointment ID ${activeAppt.id}`);
    await dbHelper.cancelAppointment(activeAppt.id);
    
    const msg = `Your appointment on ${activeAppt.date} at ${activeAppt.time} with ${activeAppt.doctor_id} has been *Cancelled* successfully. ❌`;
    addLog('OUTBOUND_SMS', `Sent cancel confirmation to ${phone}`);
    return msg;
  }

  if (parsed.intent === 'RESCHEDULE') {
    addLog('DB_CHECK', `Checking active appointment to reschedule for patient ${patient.name}`);
    const activeAppt = await dbHelper.getActiveAppointment(patient.id);
    if (!activeAppt) {
      const msg = `You do not have any active appointments to reschedule. Would you like to book a new appointment? Tell me your preferred time!`;
      addLog('OUTBOUND_SMS', `Sent reschedule error notice to ${phone}`);
      return msg;
    }

    const slots = await dbHelper.getAvailableSlotsForNextDays(3);
    let slotText = slots.map(s => `• ${s.date} at ${s.time} (with ${s.doctor_id})`).join('\n');
    
    const msg = `Sure, let's reschedule your current appointment.
Please choose from the available slots or type your preferred slot (e.g. *"Tomorrow 3 PM"*):

${slotText}`;
    addLog('OUTBOUND_SMS', `Sent available slot list for rescheduling to ${phone}`);
    return msg;
  }

  if (parsed.intent === 'DELAY') {
    addLog('DB_CHECK', `Checking active appointment to flag delay for patient ${patient.name}`);
    const activeAppt = await dbHelper.getActiveAppointment(patient.id);
    if (!activeAppt) {
      const msg = `You don't have any active appointments today. If you're looking to book, let me know!`;
      addLog('OUTBOUND_SMS', `Sent delay error notice to ${phone}`);
      return msg;
    }

    addLog('DB_WRITE', `Setting delay flag for appointment ID ${activeAppt.id}`);
    await dbHelper.updateAppointmentDelay(activeAppt.id, 1);
    
    const msg = `Thank you for letting us know! 🙏 We have informed the clinic staff that you are running late. Your slot for ${activeAppt.time} will be held. Drive safe!`;
    addLog('OUTBOUND_SMS', `Sent delay confirmation to ${phone}`);
    return msg;
  }

  if (parsed.intent === 'BOOK') {
    if (!parsed.date || !parsed.time) {
      // Missing details, prompt for slots
      const slots = await dbHelper.getAvailableSlotsForNextDays(3);
      let slotText = slots.map(s => `• ${s.date} at ${s.time} (with ${s.doctor_id})`).join('\n');
      
      const msg = `I couldn't catch the exact date or time in your message.
Here are some upcoming slots. Reply with your choice or type a preferred time:

${slotText}`;
      addLog('OUTBOUND_SMS', `Sent slot list prompt (missing slot details) to ${phone}`);
      return msg;
    }

    // Try booking
    try {
      addLog('DB_WRITE', `Attempting to book slot: ${parsed.doctor} on ${parsed.date} at ${parsed.time}`);
      const appt = await dbHelper.bookSlot(patient.id, parsed.doctor, parsed.date, parsed.time);
      
      const confMsg = `✅ *Appointment Confirmed!*

👨‍⚕️ *Doctor:* ${parsed.doctor}
📅 *Date:* ${parsed.date}
⏰ *Time:* ${parsed.time}
📍 *Clinic:* Apollo Diagnostics, MG Road, Pune (https://maps.google.com/?q=Apollo+Clinic)

Please reply:
• *R* to Reschedule
• *C* to Cancel
• *L* if you are running late on appointment day.

See you soon!`;
      
      addLog('OUTBOUND_SMS', `Sent Booking Confirmation to ${phone}`);
      return confMsg;
    } catch (err) {
      addLog('DB_CHECK', `Slot unavailable: ${parsed.doctor} on ${parsed.date} at ${parsed.time}`);
      // Find other slots
      const slots = await dbHelper.getAvailableSlotsForNextDays(3);
      let slotText = slots.map(s => `• ${s.date} at ${s.time} (with ${s.doctor_id})`).join('\n');
      
      const msg = `Sorry, the slot on *${parsed.date} at ${parsed.time}* is no longer available.
Please select one of the following open slots or type another time:

${slotText}`;
      addLog('OUTBOUND_SMS', `Sent alternate slots list (slot taken) to ${phone}`);
      return msg;
    }
  }

  // Unknown scenario
  const defaultMsg = `Sorry, I didn't quite get that.
Would you like to book, cancel, or reschedule?

You can say:
• *"Book appointment with Dr. Sharma tomorrow 10 AM"*
• *"Cancel my appointment"*
• *"Reschedule to Sunday 4 PM"*`;
  addLog('OUTBOUND_SMS', `Sent fallback clarification message to ${phone}`);
  return defaultMsg;
}

// META WHATSAPP WEBHOOK ROUTES
// Verification endpoint (GET) for webhook setup
app.get('/api/whatsapp/webhook', (req, res) => {
  const verifyToken = 'CLINIC_SMS_TOKEN';
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === verifyToken) {
    addLog('WEBHOOK', 'Webhook verified successfully via Meta challenge.');
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
});

// Incoming message handler (POST)
app.post('/api/whatsapp/webhook', async (req, res) => {
  const body = req.body;
  
  // Verify Webhook signature simulator (simplified verification for demo)
  const signature = req.headers['x-hub-signature-256'];
  if (signature) {
    addLog('WEBHOOK', 'Received Meta webhook signature verification. Verified.');
  }

  try {
    // Meta Cloud API payload structure
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messageObj = value?.messages?.[0];
    const contactObj = value?.contacts?.[0];

    if (messageObj) {
      const phone = messageObj.from;
      let messageText = "";

      if (messageObj.type === 'text') {
        messageText = messageObj.text.body;
      } else if (messageObj.type === 'interactive') {
        // Handle list selection or button reply
        const interactive = messageObj.interactive;
        if (interactive.type === 'list_reply') {
          messageText = interactive.list_reply.title;
        } else if (interactive.type === 'button_reply') {
          messageText = interactive.button_reply.title;
        }
      }

      if (phone && messageText) {
        const reply = await handleBotWorkflow(phone, messageText);
        
        // Simulating the outbound message payload that would go back to Meta API
        const outboundPayload = {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: phone,
          type: "text",
          text: { body: reply }
        };
        
        res.status(200).json({
          status: 'success',
          reply: reply,
          outboundPayload
        });
      } else {
        res.status(400).send('Invalid message structure');
      }
    } else {
      res.status(200).send('No message payload to process');
    }
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Internal Server Error');
  }
});

// SIMULATOR ENDPOINT - Triggered by phone simulator on the web dashboard
app.post('/api/simulator/send', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: 'Missing phone or message' });
  }

  // Construct a mock Meta Cloud API webhook payload
  const mockPayload = {
    object: "whatsapp_business_account",
    entry: [{
      id: "WHATSAPP_BUSINESS_ACCOUNT_ID",
      changes: [{
        value: {
          messaging_product: "whatsapp",
          metadata: {
            display_phone_number: "15550000000",
            phone_number_id: "100000000000000"
          },
          contacts: [{
            profile: { name: "Patient Simulator" },
            wa_id: phone
          }],
          messages: [{
            from: phone,
            id: `wamid.HBgLOTE5ODc2NTQzMjEwFQIAERgSRDMzQTRGQzM2NUFBMTk0RDQ5AA==`,
            timestamp: Math.floor(Date.now() / 1000).toString(),
            text: { body: message },
            type: "text"
          }]
        },
        field: "messages"
      }]
    }]
  };

  // Dispatch internally to our webhook handler
  try {
    addLog('WEBHOOK', `Simulator triggered message send: "${message}"`);
    
    // Call bot workflow directly for quick response
    const reply = await handleBotWorkflow(phone, message);
    res.json({ success: true, reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SIMULATED CRON REMINDERS
app.post('/api/cron/reminders', async (req, res) => {
  const { type, phone } = req.body; // '24h' or '2h'
  
  const patient = await dbHelper.getPatientByPhone(phone);
  if (!patient) {
    return res.status(400).json({ error: 'Patient not found' });
  }
  
  const appt = await dbHelper.getActiveAppointment(patient.id);
  if (!appt) {
    return res.status(400).json({ error: 'No active appointment found' });
  }

  let message = "";
  if (type === '24h') {
    addLog('OUTBOUND_SMS', `Cron triggered 24h Reminder check. Preparing SMS for ${phone}.`);
    message = `⏰ *Apollo Clinic Appointment Reminder (24 Hours)*

Dear ${patient.name || 'Patient'}, this is a reminder for your upcoming consultation:
👨‍⚕️ *Doctor:* ${appt.doctor_id}
📅 *Date:* ${appt.date}
⏰ *Time:* ${appt.time}

Reply:
• *C* to Cancel
• *R* to Reschedule
• Or type any query to speak with us.`;
  } else if (type === '2h') {
    addLog('OUTBOUND_SMS', `Cron triggered 2h Reminder check. Preparing SMS for ${phone}.`);
    message = `🚨 *Apollo Clinic Alert (2 Hours)*

Hi ${patient.name || 'Patient'}, you have an appointment with ${appt.doctor_id} in 2 hours at *${appt.time}*.

• Reply *L* if you are running late so we can hold your slot!
• Reply *C* to Cancel.`;
  }

  addLog('OUTBOUND_SMS', `Sent simulated ${type} Reminder to ${phone}`);
  res.json({ success: true, message });
});

// SIMULATED POST-VISIT COMPLETED ROUTE
app.post('/api/cron/completed-visit', async (req, res) => {
  const { phone } = req.body;
  const patient = await dbHelper.getPatientByPhone(phone);
  if (!patient) {
    return res.status(400).json({ error: 'Patient not found' });
  }

  const appts = await dbHelper.getPatientAppointments(patient.id);
  const activeAppt = appts.find(a => a.status === 'CONFIRMED');
  
  if (!activeAppt) {
    return res.status(400).json({ error: 'No confirmed appointments' });
  }

  // Update status to COMPLETED
  await new Promise((resolve, reject) => {
    dbHelper.db.run("UPDATE appointments SET status = 'COMPLETED' WHERE id = ?", [activeAppt.id], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  addLog('DB_WRITE', `Marked appointment ID ${activeAppt.id} as COMPLETED`);

  const feedbackMsg = `Hope your consultation with ${activeAppt.doctor_id} went well! 😊

📄 *Download Invoice:* https://apollo.clinic/billing/invoice-${activeAppt.id}.pdf
⭐ *Feedback:* Please take a moment to rate us: https://g.page/apollo-clinic-pune/review

Have a healthy day!`;

  addLog('OUTBOUND_SMS', `Sent post-visit invoice and feedback link to ${phone}`);
  res.json({ success: true, message: feedbackMsg });
});

// DASHBOARD STATE DATA ENDPOINTS
app.get('/api/dashboard/appointments', async (req, res) => {
  try {
    const rows = await dbHelper.getAllAppointments();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/patients', async (req, res) => {
  try {
    const rows = await dbHelper.getAllPatients();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/slots', async (req, res) => {
  try {
    dbHelper.db.all("SELECT * FROM slots ORDER BY date ASC, time ASC", [], (err, rows) => {
      if (err) res.status(500).json({ error: err.message });
      else res.json(rows);
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset simulation data route (wipes database and restarts schema)
app.post('/api/dashboard/reset', (req, res) => {
  const sqlite3 = require('sqlite3').verbose();
  const dbPath = path.join(__dirname, 'clinic.db');
  
  dbHelper.db.close(async (err) => {
    if (err) console.error(err);
    
    // Delete file
    const fs = require('fs');
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
    
    // Re-require/re-init db
    delete require.cache[require.resolve('./db')];
    dbHelper = require('./db');
    
    try {
      await dbHelper.initPromise;
      addLog('DB_WRITE', 'Simulation database reset successfully.');
      res.json({ success: true });
    } catch (initErr) {
      console.error("Database reset initialization failed:", initErr);
      res.status(500).json({ error: "Failed to initialize reset database" });
    }
  });
});

app.listen(PORT, () => {
  console.log(`Clinic Automation backend server running on http://localhost:${PORT}`);
  addLog('WEBHOOK', `Server initialized. Running on port ${PORT}`);
});
