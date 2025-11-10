document.addEventListener('DOMContentLoaded', () => {
    const markAttendanceBtn = document.getElementById('markAttendanceBtn');
    const cameraSection = document.getElementById('cameraSection');
    const videoFeed = document.getElementById('videoFeed');
    const captureBtn = document.getElementById('captureBtn');
    const canvas = document.getElementById('canvas');
    const resultArea = document.getElementById('resultArea');
    const capturedImage = document.getElementById('capturedImage');
    const recordTime = document.getElementById('recordTime');
    const recordDate = document.getElementById('recordDate');

    // NEW: Get the permanent display elements from main.html
    const latestDateDisplay = document.getElementById('latestDate');
    const latestTimeDisplay = document.getElementById('latestTime');

    const EMPLOYER_ID = localStorage.getItem('eppi_employer_id'); 
    const LOGGER_NAME = localStorage.getItem('eppi_user_name'); 
    
    if (!EMPLOYER_ID || !LOGGER_NAME) {
        return; 
    }

    let stream = null; 

    markAttendanceBtn.addEventListener('click', () => {
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            stream = null;
            cameraSection.style.display = 'none';
            markAttendanceBtn.textContent = 'Mark Your Attendance';
            return;
        }
        
        cameraSection.style.display = 'block';
        markAttendanceBtn.textContent = 'Stop Camera';
        resultArea.style.display = 'none';

        navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: "environment" }
        })
        .then(videoStream => {
            stream = videoStream;
            videoFeed.srcObject = stream;
            videoFeed.play();
        })
        .catch(err => {
            alert("Could not access the camera. Make sure permissions are granted (especially HTTPS).");
        });
    });

    captureBtn.addEventListener('click', () => {
        captureBtn.disabled = true;
        captureBtn.textContent = 'Recording...';

        canvas.width = videoFeed.videoWidth;
        canvas.height = videoFeed.videoHeight;
        canvas.getContext('2d').drawImage(videoFeed, 0, 0);

        const now = new Date();
        const timestamp = now.toISOString();

        canvas.toBlob(function(blob) {
            if (stream) {
                stream.getTracks().forEach(track => track.stop());
                stream = null;
            }

            const formData = new FormData();
            formData.append('photo', blob, `${EMPLOYER_ID}_${Date.now()}.jpeg`);
            formData.append('timestamp', timestamp);
            formData.append('employerId', EMPLOYER_ID);
            formData.append('loggerName', LOGGER_NAME);

            fetch('/api/attendance/mark', { // Relative path
                method: 'POST',
                body: formData 
            })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    // Update temporary success area
                    cameraSection.style.display = 'none';
                    resultArea.style.display = 'block';
                    capturedImage.src = data.record.photoUrl; 
                    recordDate.textContent = data.record.date;
                    recordTime.textContent = data.record.time;
                    resultArea.querySelector('.success-note').textContent = 'Attendance saved!';
                    
                    // NEW: Update permanent dashboard display and save to local storage
                    if (latestDateDisplay && latestTimeDisplay) {
                        latestDateDisplay.textContent = data.record.date;
                        latestTimeDisplay.textContent = data.record.time;

                        localStorage.setItem('eppi_latest_date', data.record.date);
                        localStorage.setItem('eppi_latest_time', data.record.time);
                    }
                } else {
                    alert('Error: ' + data.message);
                }
            })
            .catch(error => {
                alert('Failed to connect to the server.');
            })
            .finally(() => {
                captureBtn.disabled = false;
                captureBtn.textContent = 'Capture Photo';
                markAttendanceBtn.textContent = 'Mark Your Attendance';
            });

        }, 'image/jpeg', 0.8);
    });
});