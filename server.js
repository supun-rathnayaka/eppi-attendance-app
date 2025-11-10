require('dotenv').config();
const express = require('express');
const ExcelJS = require('exceljs');
const multer = require('multer');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2; 
const { Readable } = require('stream'); 
const nodemailer = require('nodemailer'); // <-- NEW

const app = express();
const PORT = process.env.PORT || 3000; 

// --- CLOUDINARY CONFIGURATION (Free-Forever Storage) ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});
// --- END CLOUDINARY CONFIG ---

// --- EMAIL CONFIGURATION (Nodemailer) ---
const transporter = nodemailer.createTransport({
    service: 'gmail', // Change to 'outlook' or 'Outlook365' if using Microsoft
    auth: {
        user: process.env.EMAIL_USER, // The sender's email address
        pass: process.env.EMAIL_PASS // The sender's app password
    }
});
// --- END EMAIL CONFIG ---

// --- MONGODB CONNECTION SETUP ---
const MONGODB_URI = process.env.MONGODB_URI;

mongoose.connect(MONGODB_URI)
    .then(() => console.log('MongoDB connected successfully.'))
    .catch(err => console.error('MongoDB connection error:', err));


// --- MONGODB SCHEMAS (Database Structure) ---

// 1. User Schema (UPDATED with personal details)
const UserSchema = new mongoose.Schema({
    name: { type: String, required: true },
    jobTitle: { type: String },              
    contactNumber: { type: String },         
    email: { type: String },                 
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
    photoPath: { type: String }, 
    photoUrl: { type: String, required: true } 
});

// 3. Leave Schema (NEW)
const LeaveSchema = new mongoose.Schema({
    employerId: { type: String, required: true },
    loggerName: { type: String, required: true },
    leaveType: { type: String, required: true },  
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    reason: { type: String },
    status: { type: String, default: 'Pending' }, 
    submittedAt: { type: Date, default: Date.now }
});


const User = mongoose.model('User', UserSchema);
const Attendance = mongoose.model('Attendance', AttendanceSchema);
const Leave = mongoose.model('Leave', LeaveSchema); // <-- NEW MODEL


// --- Multer Configuration ---
const upload = multer({ storage: multer.memoryStorage() });


// --- Middleware Setup ---
app.use(express.static(__dirname)); 
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));


// --- Helper Function to upload buffer to Cloudinary ---
const uploadStream = (buffer, options) => {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
            if (error) reject(error);
            else resolve(result);
        });
        Readable.from(buffer).pipe(stream);
    });
};


// --- API Endpoints ---

// API 1: Login (unchanged)
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


// API 2: Registration (UPDATED to accept new fields)
app.post('/api/register', async (req, res) => {
    const { name, employerId, jobTitle, contactNumber, email, username, password } = req.body; 
    if (!name || !employerId || !jobTitle || !contactNumber || !email || !username || !password) {
        return res.status(400).json({ success: false, message: 'All fields are required.' });
    }
    try {
        const existingUser = await User.findOne({ $or: [{ username }, { employerId }] });
        if (existingUser) {
            return res.status(409).json({ success: false, message: 'Username or Employer ID already exists.' });
        }
        
        const newUser = new User({ name, employerId, jobTitle, contactNumber, email, username, password });
        await newUser.save();
        res.json({ success: true, message: 'Registration successful! You can now log in.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error during registration.' });
    }
});


// API 3: Attendance Logging (Uploads to Cloudinary)
app.post('/api/attendance/mark', upload.single('photo'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No photo file was uploaded.' });
    }
    const { employerId, loggerName } = req.body;
    
    try {
        const now = new Date();
        const timeZone = 'Asia/Dubai'; 
        
        const dateOptions = { timeZone: timeZone, year: 'numeric', month: '2-digit', day: '2-digit' };
        const timeOptions = { timeZone: timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true };

        const formattedDate = now.toLocaleDateString('en-US', dateOptions);
        const formattedTime = now.toLocaleTimeString('en-US', timeOptions);
        
        // CLOUDINARY UPLOAD LOGIC
        const fileName = `${employerId}_${Date.now()}`;
        
        const uploadResult = await uploadStream(req.file.buffer, {
            folder: 'eppi_attendance', 
            public_id: fileName,       
            resource_type: 'image',
            overwrite: true            
        });
        
        const photoUrl = uploadResult.secure_url; 

        const newRecord = new Attendance({
            employerId: employerId,
            loggerName: loggerName,
            timestamp: now, 
            date: formattedDate, 
            time: formattedTime, 
            photoPath: uploadResult.public_id, 
            photoUrl: photoUrl 
        });

        await newRecord.save();
        res.json({ 
            success: true, 
            message: 'Attendance recorded and photo saved to Cloudinary!',
            record: {
                photoUrl: photoUrl,
                date: formattedDate, 
                time: formattedTime 
            }
        });
    } catch (error) {
        console.error('Attendance and Cloudinary upload error:', error);
        res.status(500).json({ success: false, message: 'Server error saving attendance record or photo.' });
    }
});


// API 4: Leave Submission (Saves to DB and sends Email Notification)
app.post('/api/leave/submit', async (req, res) => {
    const { employerId, loggerName, leaveType, startDate, endDate, reason } = req.body;
    
    if (!employerId || !loggerName || !leaveType || !startDate || !endDate || !reason) {
        return res.status(400).json({ success: false, message: 'All leave form fields are required.' });
    }

    try {
        // 1. Save the new leave request to MongoDB
        const newLeaveRequest = new Leave({
            employerId,
            loggerName,
            leaveType,
            startDate: new Date(startDate),
            endDate: new Date(endDate),
            reason,
            status: 'Pending' 
        });

        await newLeaveRequest.save();

        // 2. Send email notification to Admin/HR
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: process.env.ADMIN_EMAIL, // The recipient email address for HR notifications
            subject: `[EPPI HR] NEW PENDING LEAVE REQUEST: ${loggerName} (${employerId})`,
            html: `
                <p>A new leave request has been submitted and is pending your approval.</p>
                <p><strong>Employee:</strong> ${loggerName} (${employerId})</p>
                <p><strong>Leave Type:</strong> ${leaveType}</p>
                <p><strong>Period:</strong> ${startDate} to ${endDate}</p>
                <p><strong>Reason:</strong> ${reason}</p>
                <hr>
                <p>This request has been logged in the MongoDB 'Leaves' collection with status 'Pending'.</p>
            `
        };

        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                // Do not fail the API call if the email fails, just log it.
                console.error("Leave submission email notification FAILED:", error); 
            } else {
                console.log('Admin email notification sent successfully: ' + info.response);
            }
        });

        res.json({ success: true, message: 'Leave request submitted successfully! HR has been notified.' });
    } catch (error) {
        console.error('Server error during leave submission:', error);
        res.status(500).json({ success: false, message: 'Server error during leave submission.' });
    }
});


// API 5: Excel Report Generation (Access Restricted to Admin)
app.get('/api/attendance/report', async (req, res) => {
    // ... (This API remains the same) ...
    try {
        const requesterId = req.query.employerId;
        const ADMIN_ID = 'EPPI-001'; 

        if (!requesterId || requesterId !== ADMIN_ID) {
            console.warn(`Access Denied for ID: ${requesterId}`);
            return res.status(403).send('Access Denied: Only the Admin User (EPPI-001) can download this report.');
        }

        const records = await Attendance.find({}).sort({ timestamp: 1 }); 
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Attendance Report');
        
        worksheet.columns = [
            { header: 'Date', key: 'date', width: 15 },
            { header: 'Time', key: 'time', width: 15 },
            { header: 'Logger Name', key: 'loggerName', width: 25 },
            { header: 'Employer ID', key: 'employerId', width: 20 },
            { header: 'Photo URL (Cloudinary)', key: 'photoUrl', width: 60 }
        ];
        
        const excelRecords = records.map(record => ({
            date: record.date,
            time: record.time,
            loggerName: record.loggerName,
            employerId: record.employerId,
            photoUrl: record.photoUrl 
        }));

        worksheet.addRows(excelRecords);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="attendance_report.xlsx"');
        
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