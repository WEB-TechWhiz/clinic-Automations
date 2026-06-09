const http = require('http');

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;

function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}${path}`;
    const options = {
      method: method,
      headers: {
        'Content-Type': 'application/json',
      }
    };

    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            body: data ? JSON.parse(data) : null
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            body: data
          });
        }
      });
    });

    req.on('error', (err) => reject(err));

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log("==================================================");
  console.log("STARTING CLINIC WHATSAPP AUTOMATION INTEGRATION TESTS");
  console.log("==================================================");

  try {
    // 0. Reset database to starting state
    console.log("\n🔄 0. Resetting simulation database...");
    const resetRes = await makeRequest('POST', '/api/dashboard/reset');
    if (resetRes.statusCode === 200) {
      console.log("✅ Database reset successful.");
    } else {
      throw new Error(`Failed to reset DB: ${JSON.stringify(resetRes.body)}`);
    }

    // 1. Simulate new patient sending "Hello"
    console.log("\n💬 1. Simulating inbound 'Hello' from unregistered number...");
    const res1 = await makeRequest('POST', '/api/simulator/send', {
      phone: "919999999999",
      message: "Hello Apollo Clinic!"
    });
    console.log(`- Status code: ${res1.statusCode}`);
    console.log(`- Response body:`, res1.body);
    
    if (res1.body && res1.body.reply && res1.body.reply.includes('intake form')) {
      console.log("✅ Correctly prompted new patient with registration form.");
    } else {
      throw new Error(`Intake form welcome message mismatch. Body: ${JSON.stringify(res1.body)}`);
    }

    // 2. Simulate patient completing registration ("Ready")
    console.log("\n💬 2. Simulating patient replying 'Ready' after filling form...");
    const res2 = await makeRequest('POST', '/api/simulator/send', {
      phone: "919999999999",
      message: "Ready"
    });
    console.log(`- Bot reply:\n"""\n${res2.body.reply}\n"""`);
    
    if (res2.body.reply.includes('registration is complete')) {
      console.log("✅ Correctly updated patient status to ACTIVE and sent booking options.");
    } else {
      throw new Error("Registration completion reply mismatch.");
    }

    // 3. Simulate booking an appointment
    console.log("\n💬 3. Simulating slot booking in Hindi: 'kal dopahar 2 baje' (tomorrow 2 PM)...");
    const res3 = await makeRequest('POST', '/api/simulator/send', {
      phone: "919999999999",
      message: "kal dopahar ko 2 baje slot book kardo Dr. Rajesh Sharma ke sath"
    });
    console.log(`- Bot reply:\n"""\n${res3.body.reply}\n"""`);
    
    if (res3.body.reply.includes('Appointment Confirmed')) {
      console.log("✅ Appointment successfully booked and confirmed via bot engine.");
    } else {
      throw new Error("Booking confirmation mismatch.");
    }

    // Verify booking in database
    console.log("\n🔍 4. Verifying appointment booking in the admin dashboard database...");
    const dashboardAppts = await makeRequest('GET', '/api/dashboard/appointments');
    console.log(`- Total appointments: ${dashboardAppts.body.length}`);
    const latestAppt = dashboardAppts.body[0];
    console.log(`- Latest Appointment: ID #${latestAppt.id}, Doctor: ${latestAppt.doctor_id}, Date: ${latestAppt.date}, Time: ${latestAppt.time}, Status: ${latestAppt.status}`);
    
    if (latestAppt && latestAppt.status === 'CONFIRMED' && latestAppt.time === '14:00') {
      console.log("✅ Database record matches booking request.");
    } else {
      throw new Error("Database record mismatch.");
    }

    // 4. Simulate patient running late ("L")
    console.log("\n💬 5. Simulating patient sending delay alert 'L'...");
    const res4 = await makeRequest('POST', '/api/simulator/send', {
      phone: "919999999999",
      message: "L"
    });
    console.log(`- Bot reply:\n"""\n${res4.body.reply}\n"""`);
    
    if (res4.body.reply.includes('running late')) {
      console.log("✅ Delay acknowledged by the bot.");
    } else {
      throw new Error("Delay message acknowledgment mismatch.");
    }

    // Verify late flag in DB
    console.log("\n🔍 6. Checking delay flag in database...");
    const dashboardAppts2 = await makeRequest('GET', '/api/dashboard/appointments');
    const updatedAppt = dashboardAppts2.body[0];
    console.log(`- Delay flag status: ${updatedAppt.delay_flag}`);
    
    if (updatedAppt.delay_flag === 1) {
      console.log("✅ Database correctly flagged patient as running late.");
    } else {
      throw new Error("Delay flag not updated in database.");
    }

    // 5. Test 24-hour reminder Cron
    console.log("\n⏰ 7. Triggering simulated 24-hour cron reminder...");
    const res5 = await makeRequest('POST', '/api/cron/reminders', {
      type: "24h",
      phone: "919999999999"
    });
    console.log(`- Outbound SMS:\n"""\n${res5.body.message}\n"""`);
    if (res5.body.message.includes('Reminder (24 Hours)')) {
      console.log("✅ 24h Reminder cron template generated and sent successfully.");
    } else {
      throw new Error("24h reminder cron message mismatch.");
    }

    // 6. Simulate patient cancelling appointment ("C")
    console.log("\n💬 8. Simulating patient cancelling the appointment ('C')...");
    const res6 = await makeRequest('POST', '/api/simulator/send', {
      phone: "919999999999",
      message: "C"
    });
    console.log(`- Bot reply:\n"""\n${res6.body.reply}\n"""`);
    
    if (res6.body.reply && res6.body.reply.includes('Cancelled') && res6.body.reply.includes('successfully')) {
      console.log("✅ Appointment marked cancelled.");
    } else {
      throw new Error(`Cancel reply message mismatch. Body: ${JSON.stringify(res6.body)}`);
    }

    // Verify database cancellation
    console.log("\n🔍 9. Verifying cancellation in database...");
    const dashboardAppts3 = await makeRequest('GET', '/api/dashboard/appointments');
    const cancelledAppt = dashboardAppts3.body[0];
    console.log(`- Appointment ID #${cancelledAppt.id} Status: ${cancelledAppt.status}`);
    
    if (cancelledAppt.status === 'CANCELLED') {
      console.log("✅ Database marked appointment as CANCELLED successfully.");
    } else {
      throw new Error("Database status not updated to CANCELLED.");
    }

    console.log("\n==================================================");
    console.log("🎉 ALL TESTS PASSED SUCCESSFULLY! SYSTEM IS ROBUST.");
    console.log("==================================================");
  } catch (error) {
    console.error("\n❌ TEST SUITE FAILED:", error.message);
    process.exit(1);
  }
}

runTests();
