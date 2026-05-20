import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';

import adminRoutes from './routes/admin.js';
import timetableRoutes from './routes/timetable.js';
import studentRoutes from './routes/student.js';
import teacherRoutes from './routes/teacher.js';

const app = express();

// Configure CORS
const corsOptions = {
  origin: ['http://localhost:3000', 'http://localhost:3002'],
  credentials: true,
};
app.use(cors(corsOptions));

// Body parser
app.use(express.json());

// Multer configuration for PDF uploads (memory storage, 25MB limit)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// We attach multer to the app object or export it if needed by routes.
// Here we'll just export it so routes can import it if they need to handle uploads directly,
// but since routes are mounted here, we could pass it or let routes configure their own.
// Actually, it's better to export the upload middleware for routes to use.
export { upload };

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
