const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const multer = require('multer');
const mongoose = require('mongoose'); // <-- MONGODB

const app = express();
// This line is RENDER-READY: It uses Render's port or 3000 locally
const PORT = process.env.PORT || 3000; 

// --- MONGODB CONNECTION SETUP ---
// This line is RENDER-READY: It will check for Render's secret
// "Environment Variable" first, or use the local string.
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://app_user:1234@cluster0.pdqxrwa.mongodb.net/?appName=Cluster0';

mongoose.connect(MONGODB_URI)
    .then(() => console.log('MongoDB connected successfully.'))
    .catch(err => console.error('MongoDB connection error:', err));


// --- MONGODB SCHEMAS (Database Structure) ---

// 1. User Schema (Replaces users_log.json)
const UserSchema = new mongoose.Schema({
    name: { type: String, required: true },
    employerId: { type: String, required: true, unique: true },
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }
});

// 2. Attendance Schema (Replaces attendance_log.json)
const AttendanceSchema = new mongoose.Schema({
    employerId: { type: String, required: true },
    loggerName: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    date: { type: String }, 
    time: { type: String }, 
    photoPath: { type: String, required: true }, // Path on the server
    photoUrl: { type: String, required: true }  // URL to view the photo
});

const User = mongoose.model('User', UserSchema);
const Attendance = mongoose.model('Attendance', AttendanceSchema);


// --- Multer Configuration (For Photo Uploads) ---
// This saves photos to a local 'uploads' folder on the server
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        const employerId = req.body.employerId || 'UNKNOWN';
        cb(null, `${employerId}_${Date.now()}.jpeg`);
    }
});
const upload = multer({ storage: storage });


// --- Middleware Setup ---
app.use(express.static(__dirname)); // Serves all HTML, CSS, JS files
app.use('/uploads', express.static(UPLOADS_DIR)); // Makes /uploads public
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true }));


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


// API 3: Attendance Logging (Saves to MongoDB and local 'uploads')
app.post('/api/attendance/mark', upload.single('photo'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No photo file was uploaded.' });
    }
    const { employerId, loggerName } = req.body;
    
    try {
        const now = new Date();
        const newRecord = new Attendance({
            employerId: employerId,
            loggerName: loggerName,
            timestamp: now,
            date: now.toLocaleDateString('en-US'),
            time: now.toLocaleTimeString('en-US'),
            photoPath: req.file.path, 
            photoUrl: '/uploads/' + req.file.filename 
        });

        await newRecord.save();
        res.json({ 
            success: true, 
            message: 'Attendance recorded and photo saved!',
            record: {
                photoUrl: newRecord.photoUrl,
                date: newRecord.date,
                time: newRecord.time
            }
        });
    } catch (error) {
        fs.unlink(req.file.path, () => {}); // Clean up file if DB insert fails
        res.status(500).json({ success: false, message: 'Server error saving attendance record.' });
    }
});


// API 4: Excel Report Generation (Fetches data from MongoDB)
app.get('/api/attendance/report', async (req, res) => {
    try {
        const records = await Attendance.find({}).sort({ timestamp: 1 }); 
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Attendance Report');
        
        worksheet.columns = [
            { header: 'Date', key: 'date', width: 15 },
            { header: 'Time', key: 'time', width: 15 },
            { header: 'Logger Name', key: 'loggerName', width: 25 },
            { header: 'Employer ID', key: 'employerId', width: 20 },
            { header: 'Photo Filename', key: 'photoUrl', width: 40 }
        ];
        
        const excelRecords = records.map(record => ({
            date: record.date,
            time: record.time,
            loggerName: record.loggerName,
            employerId: record.employerId,
            photoUrl: path.basename(record.photoUrl)
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