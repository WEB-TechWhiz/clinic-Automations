// Current simulation phone number
const SIMULATED_PHONE = "919876543210";

// DOM Elements
const chatThread = document.getElementById('chatThread');
const chatInputForm = document.getElementById('chatInputForm');
const chatInput = document.getElementById('chatInput');
const triggerBtns = document.querySelectorAll('.trigger-btn');
const logConsole = document.getElementById('logConsole');
const clearLogsBtn = document.getElementById('clearLogsBtn');

// Stat Cards DOM
const statAppointments = document.getElementById('statAppointments');
const statPatients = document.getElementById('statPatients');
const statLate = document.getElementById('statLate');
const lateAlertCard = document.getElementById('lateAlertCard');

// Tables DOM
const appointmentsTableBody = document.querySelector('#appointmentsTable tbody');
const patientsTableBody = document.querySelector('#patientsTable tbody');

// Cron Inputs & Buttons
const cronPhone24 = document.getElementById('cronPhone24');
const btnCron24 = document.getElementById('btnCron24');
const cronPhone2 = document.getElementById('cronPhone2');
const btnCron2 = document.getElementById('btnCron2');
const cronPhoneComplete = document.getElementById('cronPhoneComplete');
const btnCronComplete = document.getElementById('btnCronComplete');
const btnResetDB = document.getElementById('btnResetDB');

// Seed inputs with default phone number
cronPhone24.value = SIMULATED_PHONE;
cronPhone2.value = SIMULATED_PHONE;
cronPhoneComplete.value = SIMULATED_PHONE;

// Tab switcher logic
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));
    
    btn.classList.add('active');
    const targetTab = btn.getAttribute('data-tab');
    document.getElementById(targetTab).classList.add('active');
  });
});

// Helper: Format Time
function getFormattedTime() {
  const d = new Date();
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Append Chat Message
function appendChatMessage(content, type = 'received') {
  const msgDiv = document.createElement('div');
  msgDiv.className = `msg ${type}`;
  
  // Format message links/phone details if any
  let formattedContent = content
    .replace(/\n/g, '<br>')
    .replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" class="chat-link">$1</a>');

  msgDiv.innerHTML = `
    <div class="msg-content">${formattedContent}</div>
    <div class="msg-time">${getFormattedTime()}</div>
  `;
  
  chatThread.appendChild(msgDiv);
  chatThread.scrollTop = chatThread.scrollHeight;
}

// SIMULATOR: Send Message
async function sendSimulatorMessage(message) {
  appendChatMessage(message, 'sent');
  
  try {
    const res = await fetch('/api/simulator/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: SIMULATED_PHONE, message })
    });
    
    const data = await res.json();
    if (data.reply) {
      setTimeout(() => {
        appendChatMessage(data.reply, 'received');
        updateDashboardData();
      }, 800); // Realistic short network delay
    }
  } catch (err) {
    console.error("Failed to send simulator message:", err);
    appendChatMessage("⚠️ Error connecting to server. Please check if the server is running.", "received");
  }
}

// Chat input form handler
chatInputForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  sendSimulatorMessage(text);
  chatInput.value = '';
});

// Click scenario button triggers
triggerBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const msg = btn.getAttribute('data-msg');
    sendSimulatorMessage(msg);
  });
});

// FETCH & RENDER DASHBOARD
async function updateDashboardData() {
  try {
    // 1. Fetch appointments
    const apptsRes = await fetch('/api/dashboard/appointments');
    const appointments = await apptsRes.json();
    
    // 2. Fetch patients
    const patientsRes = await fetch('/api/dashboard/patients');
    const patients = await patientsRes.json();

    // Render Stats
    statAppointments.innerText = appointments.length;
    statPatients.innerText = patients.length;
    
    const lateCount = appointments.filter(a => a.delay_flag === 1 && a.status === 'CONFIRMED').length;
    statLate.innerText = lateCount;
    if (lateCount > 0) {
      lateAlertCard.style.display = 'flex';
    } else {
      lateAlertCard.style.display = 'none';
    }

    // Render Appointments Table
    if (appointments.length === 0) {
      appointmentsTableBody.innerHTML = `<tr><td colspan="8" class="empty-state">No appointments booked yet.</td></tr>`;
    } else {
      appointmentsTableBody.innerHTML = appointments.map(appt => {
        const delayBadge = appt.delay_flag === 1 && appt.status === 'CONFIRMED'
          ? `<span class="badge late"><i class="fas fa-exclamation-triangle"></i> LATE</span>` 
          : '';
        
        return `
          <tr>
            <td>#${appt.id}</td>
            <td><strong>${appt.patient_name || 'Unregistered'}</strong></td>
            <td>+${appt.phone_number}</td>
            <td>${appt.doctor_id}</td>
            <td>${appt.date}</td>
            <td>${appt.time}</td>
            <td><span class="badge ${appt.status.toLowerCase()}">${appt.status}</span></td>
            <td>${delayBadge}</td>
          </tr>
        `;
      }).join('');
    }

    // Render Patients Table
    if (patients.length === 0) {
      patientsTableBody.innerHTML = `<tr><td colspan="5" class="empty-state">No registered patients found.</td></tr>`;
    } else {
      patientsTableBody.innerHTML = patients.map(p => {
        const formattedDate = new Date(p.created_at).toLocaleDateString([], {
          year: 'numeric', month: 'short', day: 'numeric'
        });
        
        return `
          <tr>
            <td>#${p.id}</td>
            <td>+${p.phone_number}</td>
            <td><strong>${p.name || 'Pending registration'}</strong></td>
            <td><span class="badge ${p.status.toLowerCase()}">${p.status}</span></td>
            <td>${formattedDate}</td>
          </tr>
        `;
      }).join('');
    }

  } catch (err) {
    console.error("Dashboard fetch failed:", err);
  }
}

// ESTABLISH SSE CONNECTION FOR LOGS
function startLogStream() {
  const eventSource = new EventSource('/api/logs/stream');
  
  eventSource.onmessage = (event) => {
    const log = JSON.parse(event.data);
    
    const logLine = document.createElement('div');
    logLine.className = 'log-line';
    
    const timestampStr = new Date(log.timestamp).toLocaleTimeString([], { 
      hour: '2-digit', minute: '2-digit', second: '2-digit' 
    });
    
    let detailsHtml = '';
    if (log.details) {
      detailsHtml = `<pre class="log-details-pre">${log.details}</pre>`;
    }
    
    logLine.innerHTML = `
      <span class="log-meta">[${timestampStr}]</span>
      <span class="log-tag ${log.step}">${log.step}</span>
      <span class="log-msg">${log.message}</span>
      ${detailsHtml}
    `;
    
    logConsole.appendChild(logLine);
    logConsole.scrollTop = logConsole.scrollHeight;
  };
  
  eventSource.onerror = (err) => {
    console.error("SSE stream errored, retrying in 5 seconds...", err);
    eventSource.close();
    setTimeout(startLogStream, 5000);
  };
}

// Clear log UI
clearLogsBtn.addEventListener('click', async () => {
  await fetch('/api/logs/clear', { method: 'POST' });
  logConsole.innerHTML = '';
});

// CRON TRIGGER EVENT LISTENERS
btnCron24.addEventListener('click', async () => {
  const phone = cronPhone24.value.trim();
  if (!phone) return alert("Please specify a phone number");
  
  try {
    const res = await fetch('/api/cron/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: '24h', phone })
    });
    const data = await res.json();
    if (data.success && data.message) {
      appendChatMessage(data.message, 'received');
      alert("Simulated 24-hour reminder sent to WhatsApp phone simulator!");
    } else {
      alert("Error: " + (data.error || "Could not fire 24h cron"));
    }
  } catch (err) {
    alert("Connection error: " + err.message);
  }
});

btnCron2.addEventListener('click', async () => {
  const phone = cronPhone2.value.trim();
  if (!phone) return alert("Please specify a phone number");
  
  try {
    const res = await fetch('/api/cron/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: '2h', phone })
    });
    const data = await res.json();
    if (data.success && data.message) {
      appendChatMessage(data.message, 'received');
      alert("Simulated 2-hour delay check reminder sent to WhatsApp phone simulator!");
    } else {
      alert("Error: " + (data.error || "Could not fire 2h cron"));
    }
  } catch (err) {
    alert("Connection error: " + err.message);
  }
});

btnCronComplete.addEventListener('click', async () => {
  const phone = cronPhoneComplete.value.trim();
  if (!phone) return alert("Please specify a phone number");
  
  try {
    const res = await fetch('/api/cron/completed-visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (data.success && data.message) {
      appendChatMessage(data.message, 'received');
      updateDashboardData();
      alert("Simulated appointment completion. Feedback link & PDF bill sent!");
    } else {
      alert("Error: " + (data.error || "Could not complete visit"));
    }
  } catch (err) {
    alert("Connection error: " + err.message);
  }
});

btnResetDB.addEventListener('click', async () => {
  if (!confirm("Are you sure you want to delete all appointment data and reset the simulation?")) return;
  
  try {
    const res = await fetch('/api/dashboard/reset', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      chatThread.innerHTML = `
        <div class="system-date">TODAY</div>
        <div class="msg received">
          <div class="msg-content">
            Database reset. Namaste! Welcome to Apollo Clinic. Type any message to start.
          </div>
          <div class="msg-time">${getFormattedTime()}</div>
        </div>
      `;
      logConsole.innerHTML = '';
      updateDashboardData();
      alert("Simulation database has been reset to seed values.");
    }
  } catch (err) {
    alert("Reset failed: " + err.message);
  }
});

// INITALIZE APPLICATION ON LOAD
window.addEventListener('DOMContentLoaded', () => {
  updateDashboardData();
  startLogStream();
});
