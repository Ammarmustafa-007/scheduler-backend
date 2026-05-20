import express from 'express';
import { checkRole } from '../middleware/checkRole.js';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

router.use(checkRole(['admin', 'student', 'teacher']));

router.get('/latest', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'GET /latest' });
});

router.get('/slots', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'GET /slots' });
});

export default router;
