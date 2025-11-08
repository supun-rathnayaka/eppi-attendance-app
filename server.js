require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const multer = require('multer');
const mongoose = require('mongoose');

const app = express();
// This line is RENDER-READY: It uses Render's port or 3000 locally
const PORT = process.env.PORT || 3000; 

// --- MONGODB CONNECTION SETUP ---
const MONGODB_URI = process.env.MONGODB_URI;

mongoose.connect(MONGODB_URI)
    .then(() => console.log('MongoDB connected successfully.'))
    .catch(err => console.error('MongoDB connection error:', err));


// --- MONGODB SCHEMAS (Database Structure) ---

// 1. User Schema 
const UserSchema = new mongoose.Schema({
    name: { type: String, required: true },
    employerId: { type: String, required: true, unique: true },
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }
});

// 2. Attendance Schema 
const AttendanceSchema = new mongoose.Schema({
    employerId: { type: String, required: true },
    loggerName: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    date: { type: String }, 
    time: { type: String }, 
    photoPath: { type: String, required: true }, 
    photoUrl: { type: String, required: true } 
});

const User = mongoose.model('User', UserSchema);
const Attendance = mongoose.model('Attendance', AttendanceSchema);


// --- Multer Configuration (For Photo Uploads - RENDER READY) ---
// RENDER FIX: Switched to memoryStorage. The photo is kept in server memory
// for the duration of the request, preventing it from crashing on Render.
const upload = multer({ storage: multer.memoryStorage() });


// --- Middleware Setup ---
app.use(express.static(__dirname)); // Serves all HTML, CSS, JS files
// RENDER FIX: Removed 'app.use('/uploads', express.static(UPLOADS_DIR));' 
// as files are no longer saved to a local folder.
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));


// --- API Endpoints (Using Mongoose) ---

// API 1: Login (Finds user in MongoDB)
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username, password }); 
        if (user) {
            return res.json({ 
                success: true, 
                user: { name: user.name, employerId: user.employerId }
            });
        } else {
            return res.status(401).json({ success: false, message: 'Invalid username or password.' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});


// API 2: Registration (Saves new user to MongoDB)
app.post('/api/register', async (req, res) => {
    const { name, employerId, username, password } = req.body;
    if (!name || !employerId || !username || !password) {
        return res.status(400).json({ success: false, message: 'All fields are required.' });
    }
    try {
        const existingUser = await User.findOne({ $or: [{ username }, { employerId }] });
        if (existingUser) {
            return res.status(409).json({ success: false, message: 'Username or Employer ID already exists.' });
        }
        
        const newUser = new User({ name, employerId, username, password });
        await newUser.save();
        res.json({ success: true, message: 'Registration successful! You can now log in.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error during registration.' });
    }
});


// API 3: Attendance Logging (Saves to MongoDB)
app.post('/api/attendance/mark', upload.single('photo'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No photo file was uploaded.' });
    }
    const { employerId, loggerName } = req.body;
    
    try {
        const now = new Date();

        // --- TIMEZONE FIX: Set to Asia/Dubai (UTC+4) ---
        const timeZone = 'Asia/Dubai'; 
        
        // Define formatting options for date and time
        const dateOptions = {
            timeZone: timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        };
        
        const timeOptions = {
            timeZone: timeZone,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true 
        };

        // Create the correct date/time strings for Dubai
        const formattedDate = now.toLocaleDateString('en-US', dateOptions);
        const formattedTime = now.toLocaleTimeString('en-US', timeOptions);
        // --- END OF FIX ---

        const newRecord = new Attendance({
            employerId: employerId,
            loggerName: loggerName,
            timestamp: now, 
            date: formattedDate, // CORRECT local date string
            time: formattedTime, // CORRECT local time string
            // RENDER FIX: Use placeholder paths since photo is in memory
            photoPath: 'IN_MEMORY', 
            photoUrl: req.file.originalname // Use original name as a unique ID/URL
        });

        await newRecord.save();
        res.json({ 
            success: true, 
            message: 'Attendance recorded successfully!',
            record: {
                photoUrl: newRecord.photoUrl,
                date: formattedDate, 
                time: formattedTime 
            }
        });
    } catch (error) {
        // RENDER FIX: Removed file cleanup since nothing was saved to disk
        res.status(500).json({ success: false, message: 'Server error saving attendance record.' });
    }
});


// API 4: Excel Report Generation (Access Restricted to Admin)
app.get('/api/attendance/report', async (req, res) => {
    try {
        // 1. Get the requester's ID from the URL query
        const requesterId = req.query.employerId;
        
        // 2. Define the Admin ID 
        const ADMIN_ID = 'EPPI-001'; 

        // 3. ENFORCE ACCESS CONTROL
        if (!requesterId || requesterId !== ADMIN_ID) {
            console.warn(`Access Denied for ID: ${requesterId}`);
            // Send a 403 Forbidden status code and a message
            return res.status(403).send('Access Denied: Only the Admin User (EPPI-001) can download this report.');
        }

        // --- If access is granted, proceed with report generation ---
        const records = await Attendance.find({}).sort({ timestamp: 1 }); 
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Attendance Report');
        
        // Define columns
        worksheet.columns = [
            { header: 'Date', key: 'date', width: 15 },
            { header: 'Time', key: 'time', width: 15 },
            { header: 'Logger Name', key: 'loggerName', width: 25 },
            { header: 'Employer ID', key: 'employerId', width: 20 },
            { header: 'Photo ID', key: 'photoUrl', width: 40 }
        ];
        
        const excelRecords = records.map(record => ({
            date: record.date,
            time: record.time,
            loggerName: record.loggerName,
            employerId: record.employerId,
            photoUrl: record.photoUrl 
        }));

        worksheet.addRows(excelRecords);

        // Set response headers for file download
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="attendance_report.xlsx"');
        
        // Write the workbook to the response stream
        await workbook.xlsx.write(res);
        res.end();

    } catch (error) { 
        console.error('Report generation error:', error);
        res.status(500).send('Failed to generate report.'); 
    }
});


// --- Start the Server ---
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});