import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import adminRoutes from './routes/admin.js';
import timetableRoutes from './routes/timetable.js';
import studentRoutes from './routes/student.js';
import teacherRoutes from './routes/teacher.js';

const app = express();

// Configure CORS
const corsOptions = {
  origin: true, // Allow all origins for local development
  credentials: true,
};
app.use(cors(corsOptions));

// Body parser with increased limit for large PDF parser payloads
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));



// Mount routes
app.use('/api/admin', adminRoutes);
app.use('/api/timetable', timetableRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/teacher', teacherRoutes);

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Scheduler backend running on port ${PORT}`);
});
