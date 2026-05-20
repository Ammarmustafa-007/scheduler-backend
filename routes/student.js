import express from 'express';
import { checkRole } from '../middleware/checkRole.js';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

router.use(checkRole('student'));

router.post('/preferences/parse', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'POST /preferences/parse' });
});

router.post('/schedules/generate', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'POST /schedules/generate' });
});

router.post('/enroll', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'POST /enroll' });
});

router.get('/schedule', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'GET /schedule' });
});

router.get('/export/ics', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'GET /export/ics' });
});

export default router;
