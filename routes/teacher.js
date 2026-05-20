import express from 'express';
import { checkRole } from '../middleware/checkRole.js';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

router.use(checkRole('teacher'));

router.get('/sections', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'GET /sections' });
});

router.post('/assign-section', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'POST /assign-section' });
});

router.get('/section/:sectionId/students', (req, res) => {
  res.status(200).json({ status: 'ok', route: `GET /section/${req.params.sectionId}/students` });
});

router.get('/stats', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'GET /stats' });
});

router.get('/my-schedule', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'GET /my-schedule' });
});

router.get('/student/:id/schedule', (req, res) => {
  res.status(200).json({ status: 'ok', route: `GET /student/${req.params.id}/schedule` });
});

router.post('/makeup/check', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'POST /makeup/check' });
});

router.post('/makeup/save', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'POST /makeup/save' });
});

router.get('/makeup/history', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'GET /makeup/history' });
});

export default router;
