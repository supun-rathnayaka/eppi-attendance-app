require('dotenv').config();
const express = require('express');
const ExcelJS = require('exceljs');
const multer = require('multer');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2; 
const { Readable } = require('stream'); 
// *** NEW: Using the correct, modern Brevo package name ***
const Brevo = require('sib-api-v3-sdk'); 
const bcrypt = require('bcryptjs'); 

const app = express();
const PORT = process.env.PORT || 3000; 

// --- CLOUDINARY CONFIGURATION ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// --- BREVO (SENDINBLUE) API CONFIGURATION ---
// 1. Configure the API Key on the default client instance
const defaultClient = Brevo.ApiClient.instance;
defaultClient.authentications['api-key'].apiKey = process.env.BREVO_API_KEY;

// 2. Create the Transactional Email API Instance (which uses the default config)
const apiInstance = new Brevo.TransactionalEmailsApi();
// --- END BREVO CONFIG ---

// --- MONGODB CONNECTION SETUP ---
const MONGODB_URI = process.env.MONGODB_URI;
mongoose.connect(MONGODB_URI)
    .then(() => console.log('MongoDB connected successfully.'))
    .catch(err => console.error('MongoDB connection error:', err));


// --- MONGODB SCHEMAS ---
const UserSchema = new mongoose.Schema({
    name: { type: String, required: true },
    jobTitle: { type: String },              
    contactNumber: { type: String },         
    email: { type: String },                 
    employerId: { type: String, required: true, unique: true },
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true } 
});

const AttendanceSchema = new mongoose.Schema({
    employerId: { type: String, required: true },
    loggerName: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    date: { type: String }, 
    time: { type: String }, 
    photoPath: { type: String }, 
    photoUrl: { type: String, required: true } 
});

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
const Leave = mongoose.model('Leave', LeaveSchema);

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

// API 1: Login (SECURED with HASHING)
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username }); 
        
        if (user) {
            // 1. COMPARE HASHED PASSWORD
            const isMatch = await bcrypt.compare(password, user.password);

            if (isMatch) {
                return res.json({ 
                    success: true, 
                    user: { name: user.name, employerId: user.employerId }
                });
            }
        } 
        
        return res.status(401).json({ success: false, message: 'Invalid username or password.' });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, message: 'Server error during login.' });
    }
});

// API 2: Registration (SECURED with HASHING)
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

        // 1. HASH THE PASSWORD BEFORE SAVING
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        
        const newUser = new User({ 
            name, employerId, jobTitle, contactNumber, email, username, 
            password: hashedPassword 
        });
        await newUser.save();
        res.json({ success: true, message: 'Registration successful! You can now log in.' });
    } catch (error) {
        console.error('Server error during registration:', error);
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

// API 4: Leave Submission
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

        // 2. Send email notification via Brevo API
        let sendSmtpEmail = new Brevo.SendSmtpEmail(); // *** Use the new namespace Brevo.SendSmtpEmail()
        sendSmtpEmail.subject = `[EPPI HR] NEW PENDING LEAVE REQUEST: ${loggerName} (${employerId})`;
        sendSmtpEmail.htmlContent = `
            <p>A new leave request has been submitted and is pending your approval.</p>
            <p><strong>Employee:</strong> ${loggerName} (${employerId})</p>
            <p><strong>Leave Type:</strong> ${leaveType}</p>
            <p><strong>Period:</strong> ${startDate} to ${endDate}</p>
            <p><strong>Reason:</strong> ${reason}</p>
            <hr>
            <p>This request has been logged in the MongoDB 'Leaves' collection with status 'Pending'.</p>
        `;
        // Sender MUST be a verified sender in your Brevo account
        sendSmtpEmail.sender = { name: "EPPI HR System", email: process.env.EMAIL_USER };
        sendSmtpEmail.to = [{ email: process.env.ADMIN_EMAIL }]; // Recipient

        // Send the email
        try {
            await apiInstance.sendTransacEmail(sendSmtpEmail);
            console.log('Brevo email notification sent successfully.');
        } catch (emailError) {
            console.error("Brevo email notification FAILED:", emailError);
        }

        res.json({ success: true, message: 'Leave request submitted successfully! HR has been notified.' });
    
    } catch (dbError) {
        console.error('Server error during leave submission:', dbError);
        res.status(500).json({ success: false, message: 'Server error during leave submission.' });
    }
});

// API 5: Excel Report Generation (Access Restricted to Admin)
app.get('/api/attendance/report', async (req, res) => {
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