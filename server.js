const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const { randomUUID } = require("crypto");
const twilio = require("twilio");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const STORE_FILES = {
  appointments: "appointments.json",
  spares: "spares.json",
  feedback: "feedback.json",
  contacts: "contacts.json",
  customerRecords: "customer-records.json",
};

const ensureDataDir = async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
};

const readJson = async (filePath, fallback) => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const data = JSON.parse(raw);
    return data ?? fallback;
  } catch (err) {
    if (err.code === "ENOENT") {
      await writeJson(filePath, fallback);
      return fallback;
    }
    throw err;
  }
};

const writeJson = async (filePath, data) => {
  const payload = JSON.stringify(data, null, 2);
  await fs.writeFile(filePath, payload, "utf-8");
};

const loadStore = async (key) => {
  const filePath = path.join(DATA_DIR, STORE_FILES[key]);
  return readJson(filePath, []);
};

const saveStore = async (key, data) => {
  const filePath = path.join(DATA_DIR, STORE_FILES[key]);
  await writeJson(filePath, data);
};

const addRecord = async (key, record) => {
  const records = await loadStore(key);
  records.push(record);
  await saveStore(key, records);
  return record;
};

const respondError = (res, status, message) => {
  res.status(status).json({ ok: false, message });
};

const getTwilioClient = () => {
  const sid = process.env.TWILIO_SID;
  const token = process.env.TWILIO_AUTH;
  if (!sid || !token) return null;
  return twilio(sid, token);
};

const sendSms = async ({ to, body }) => {
  const client = getTwilioClient();
  const from = process.env.TWILIO_PHONE;
  if (!client || !from) {
    console.warn("SMS service not configured. Skipping SMS.");
    return;
  }
  if (!to.startsWith("+")) {
    const defaultCountry = process.env.DEFAULT_COUNTRY_CODE || "+91";
    to = `${defaultCountry}${to.replace(/[^0-9]/g, "")}`;
  }
  if (!/^\+\d{10,15}$/.test(to)) {
    console.warn(`Invalid phone number "${to}". Skipping SMS.`);
    return;
  }
  await client.messages.create({ from, to, body });
};

const notifyCustomerAndAdmin = async ({ customerPhone, adminPhone, body }) => {
  const smsTasks = [];

  if (customerPhone) {
    smsTasks.push(sendSms({ to: customerPhone, body }));
  }
  if (adminPhone) {
    smsTasks.push(sendSms({ to: adminPhone, body: `[ADMIN] ${body}` }));
  }

  if (smsTasks.length === 0) {
    console.warn("SMS recipients are not configured. Skipping notifications.");
    return;
  }

  await Promise.all(smsTasks);
};

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "Login.html"));
});

app.post("/spare.html", (req, res) => {
  res.redirect(303, "/spare.html");
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const adminUser = process.env.ADMIN_USER || "admin";
  const adminPass = process.env.ADMIN_PASS || "admin123";

  if (!username || !password) {
    return respondError(res, 400, "Missing username or password.");
  }

  if (username !== adminUser || password !== adminPass) {
    return respondError(res, 401, "Invalid credentials.");
  }

  return res.json({ ok: true });
});

app.post("/api/appointments", async (req, res) => {
  const { name, phone, address, vehicle, issue } = req.body || {};

  if (!name || !phone || !address || !vehicle || !issue) {
    return respondError(res, 400, "All appointment fields are required.");
  }

  const record = {
    id: randomUUID(),
    type: "Appointment",
    name,
    phone,
    address,
    details: `Vehicle: ${vehicle} | Issue: ${issue}`,
    createdAt: new Date().toISOString(),
  };

  await addRecord("appointments", { ...record, vehicle, issue });
  await addRecord("customerRecords", record);

  try {
    await notifyCustomerAndAdmin({
      customerPhone: phone,
      adminPhone: process.env.ADMIN_PHONE,
      body: `Hi ${name}, your appointment is confirmed. Vehicle: ${vehicle}. Issue: ${issue}.`,
    });
  } catch (err) {
    console.warn("Appointment notification failed:", err.message);
  }

  return res.json({ ok: true, record });
});

app.post("/api/spares", async (req, res) => {
  const { name, phone, address, parts, total } = req.body || {};

  if (!name || !phone || !address || !Array.isArray(parts) || parts.length === 0) {
    return respondError(res, 400, "Customer details and at least one part are required.");
  }

  const partsSummary = parts
    .map((part) => `${part.name || "Part"} | Qty: ${part.qty || "1"} | Amount: ${part.amount || "0"}`)
    .join(" | ");

  const record = {
    id: randomUUID(),
    type: "Spare Parts",
    name,
    phone,
    address,
    details: `${partsSummary} | Total: ${total || "0"}`,
    createdAt: new Date().toISOString(),
  };

  await addRecord("spares", { ...record, parts, total });
  await addRecord("customerRecords", record);

  try {
    await notifyCustomerAndAdmin({
      customerPhone: phone,
      adminPhone: process.env.ADMIN_PHONE,
      body: `Hi ${name}, your spare parts request was received. Items: ${partsSummary}. Total: ${total || "0"}.`,
    });
  } catch (err) {
    console.warn("Spare parts notification failed:", err.message);
  }

  return res.json({ ok: true, record });
});

process.on("unhandledRejection", (err) => {
  console.warn("Unhandled rejection:", err && err.message ? err.message : err);
});

app.post("/api/feedback", async (req, res) => {
  const { name, message, rating } = req.body || {};
  const ratingValue = Number(rating);

  if (!name || !message || !Number.isFinite(ratingValue) || ratingValue <= 0) {
    return respondError(res, 400, "Name, message, and rating are required.");
  }

  const record = {
    id: randomUUID(),
    name,
    message,
    rating: ratingValue,
    createdAt: new Date().toISOString(),
  };

  await addRecord("feedback", record);
  return res.json({ ok: true, record });
});

app.get("/api/feedback", async (req, res) => {
  const records = await loadStore("feedback");
  res.json({ ok: true, records });
});

app.post("/api/contact", async (req, res) => {
  const { name, phone, message } = req.body || {};

  if (!name || !phone || !message) {
    return respondError(res, 400, "All contact fields are required.");
  }

  const record = {
    id: randomUUID(),
    name,
    phone,
    message,
    createdAt: new Date().toISOString(),
  };

  await addRecord("contacts", record);
  return res.json({ ok: true });
});

app.get("/api/customer-records", async (req, res) => {
  const records = await loadStore("customerRecords");
  res.json({ ok: true, records });
});

app.delete("/api/customer-records/:id", async (req, res) => {
  const { id } = req.params;
  const records = await loadStore("customerRecords");
  const next = records.filter((record) => record.id !== id);

  if (next.length === records.length) {
    return respondError(res, 404, "Record not found.");
  }

  await saveStore("customerRecords", next);
  return res.json({ ok: true });
});

const start = async () => {
  await ensureDataDir();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
};

start();
