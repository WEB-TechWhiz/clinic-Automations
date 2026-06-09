const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, 'clinic.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Failed to connect to SQLite database:', err.message);
  }
});

// Initialize database schema wrapped in a Promise
const initPromise = new Promise((resolve, reject) => {
  db.serialize(() => {
    // 1. Create Patients Table
    db.run(`
      CREATE TABLE IF NOT EXISTS patients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone_number TEXT UNIQUE NOT NULL,
        name TEXT,
        status TEXT DEFAULT 'NEW', -- 'NEW', 'ACTIVE'
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 2. Create Appointments Table
    db.run(`
      CREATE TABLE IF NOT EXISTS appointments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_id INTEGER,
        doctor_id TEXT NOT NULL,
        date TEXT NOT NULL,         -- 'YYYY-MM-DD'
        time TEXT NOT NULL,         -- 'HH:MM'
        status TEXT DEFAULT 'CONFIRMED', -- 'PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED'
        delay_flag INTEGER DEFAULT 0,    -- 0 = on time, 1 = running late
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (patient_id) REFERENCES patients(id)
      )
    `);

    // 3. Create Available Slots Table
    db.run(`
      CREATE TABLE IF NOT EXISTS slots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doctor_id TEXT NOT NULL,
        date TEXT NOT NULL,         -- 'YYYY-MM-DD'
        time TEXT NOT NULL,         -- 'HH:MM'
        is_booked INTEGER DEFAULT 0 -- 0 = free, 1 = booked
      )
    `);

    // Seed initial clinic data if empty
    db.get("SELECT COUNT(*) as count FROM patients", (err, row) => {
      if (err) return reject(err);
      if (row.count === 0) {
        const stmt = db.prepare("INSERT INTO patients (phone_number, name, status) VALUES (?, ?, ?)");
        stmt.run("919876543210", "Amit Patel", "ACTIVE");
        stmt.run("918765432109", "Priya Nair", "ACTIVE");
        stmt.finalize(() => {
          console.log("Seeded default patients.");
        });
      }
    });

    // Seed Slots for next 7 days for two doctors
    db.get("SELECT COUNT(*) as count FROM slots", (err, row) => {
      if (err) return reject(err);
      if (row.count === 0) {
        const stmt = db.prepare("INSERT INTO slots (doctor_id, date, time) VALUES (?, ?, ?)");
        const doctors = ["Dr. Rajesh Sharma", "Dr. Sneha Patil"];
        const times = ["10:00", "11:00", "12:00", "14:00", "15:00", "16:00"];

        for (let i = 0; i < 7; i++) {
          const d = new Date();
          d.setDate(d.getDate() + i);
          const dateStr = d.toISOString().split('T')[0];

          doctors.forEach(doc => {
            times.forEach(t => {
              stmt.run(doc, dateStr, t);
            });
          });
        }
        stmt.finalize(() => {
          console.log("Seeded availability slots for the next 7 days.");
        });
      }
    });

    // Final dummy query to ensure serialize block is completed before resolving
    db.get("SELECT 1", (err) => {
      if (err) {
        reject(err);
      } else {
        console.log("Database initialized and fully seeded.");
        resolve();
      }
    });
  });
});

module.exports = {
  db,
  initPromise,
  
  getPatientByPhone: (phone) => {
    return new Promise((resolve, reject) => {
      db.get("SELECT * FROM patients WHERE phone_number = ?", [phone], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },

  createPatient: (phone, name = null, status = 'NEW') => {
    return new Promise((resolve, reject) => {
      db.run("INSERT INTO patients (phone_number, name, status) VALUES (?, ?, ?)", [phone, name, status], function(err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, phone_number: phone, name, status });
      });
    });
  },

  updatePatientStatus: (id, name, status) => {
    return new Promise((resolve, reject) => {
      db.run("UPDATE patients SET name = ?, status = ? WHERE id = ?", [name, status, id], (err) => {
        if (err) reject(err);
        else resolve(true);
      });
    });
  },

  getAvailableSlots: (date) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT DISTINCT doctor_id, date, time FROM slots WHERE date = ? AND is_booked = 0 ORDER BY time ASC",
        [date],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  },

  getAvailableSlotsForNextDays: (days = 3) => {
    return new Promise((resolve, reject) => {
      const dates = [];
      for (let i = 0; i < days; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i);
        dates.push(d.toISOString().split('T')[0]);
      }
      
      const placeholders = dates.map(() => '?').join(',');
      db.all(
        `SELECT id, doctor_id, date, time FROM slots WHERE date IN (${placeholders}) AND is_booked = 0 ORDER BY date ASC, time ASC LIMIT 15`,
        dates,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  },

  bookSlot: (patientId, doctorId, date, time) => {
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        db.get(
          "SELECT id FROM slots WHERE doctor_id = ? AND date = ? AND time = ? AND is_booked = 0",
          [doctorId, date, time],
          (err, slot) => {
            if (err || !slot) {
              db.run("ROLLBACK");
              reject(err || new Error("Slot unavailable"));
              return;
            }
            
            db.run(
              "UPDATE slots SET is_booked = 1 WHERE id = ?",
              [slot.id],
              (err) => {
                if (err) {
                  db.run("ROLLBACK");
                  reject(err);
                  return;
                }
                
                db.run(
                  "UPDATE appointments SET status = 'CANCELLED' WHERE patient_id = ? AND date = ? AND status = 'CONFIRMED'",
                  [patientId, date],
                  (err) => {
                    if (err) {
                      db.run("ROLLBACK");
                      reject(err);
                      return;
                    }
                    
                    db.run(
                      "INSERT INTO appointments (patient_id, doctor_id, date, time, status) VALUES (?, ?, ?, ?, 'CONFIRMED')",
                      [patientId, doctorId, date, time],
                      function(err) {
                        if (err) {
                          db.run("ROLLBACK");
                          reject(err);
                        } else {
                          db.run("COMMIT");
                          resolve({ id: this.lastID, patient_id: patientId, doctor_id: doctorId, date, time });
                        }
                      }
                    );
                  }
                );
              }
            );
          }
        );
      });
    });
  },

  getPatientAppointments: (patientId) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT * FROM appointments WHERE patient_id = ? ORDER BY date DESC, time DESC",
        [patientId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  },

  getActiveAppointment: (patientId) => {
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT * FROM appointments WHERE patient_id = ? AND status = 'CONFIRMED' ORDER BY date ASC, time ASC LIMIT 1",
        [patientId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  },

  cancelAppointment: (appointmentId) => {
    return new Promise((resolve, reject) => {
      db.get("SELECT doctor_id, date, time FROM appointments WHERE id = ?", [appointmentId], (err, appt) => {
        if (err || !appt) {
          reject(err || new Error("Appointment not found"));
          return;
        }

        db.serialize(() => {
          db.run("BEGIN TRANSACTION");
          db.run(
            "UPDATE appointments SET status = 'CANCELLED' WHERE id = ?",
            [appointmentId],
            (err) => {
              if (err) {
                db.run("ROLLBACK");
                reject(err);
                return;
              }
              db.run(
                "UPDATE slots SET is_booked = 0 WHERE doctor_id = ? AND date = ? AND time = ?",
                [appt.doctor_id, appt.date, appt.time],
                (err) => {
                  if (err) {
                    db.run("ROLLBACK");
                    reject(err);
                  } else {
                    db.run("COMMIT");
                    resolve(true);
                  }
                }
              );
            }
          );
        });
      });
    });
  },

  updateAppointmentDelay: (appointmentId, flag) => {
    return new Promise((resolve, reject) => {
      db.run(
        "UPDATE appointments SET delay_flag = ? WHERE id = ?",
        [flag, appointmentId],
        (err) => {
          if (err) reject(err);
          else resolve(true);
        }
      );
    });
  },

  getAllAppointments: () => {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT a.id, a.doctor_id, a.date, a.time, a.status, a.delay_flag, p.name as patient_name, p.phone_number 
         FROM appointments a 
         JOIN patients p ON a.patient_id = p.id 
         ORDER BY a.date ASC, a.time ASC`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  },

  getAllPatients: () => {
    return new Promise((resolve, reject) => {
      db.all("SELECT * FROM patients ORDER BY created_at DESC", [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }
};
