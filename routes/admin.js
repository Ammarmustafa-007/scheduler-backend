import express from 'express';
import { checkRole } from '../middleware/checkRole.js';
import { upload } from '../server.js'; // Importing multer configured in server.js

const router = express.Router();

router.use(checkRole('admin'));

router.post('/upload', upload.single('file'), (req, res) => {
  res.status(200).json({ status: 'ok', route: 'POST /upload (will call Python parser)' });
});

router.get('/versions', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'GET /versions' });
});

router.get('/stats', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'GET /stats' });
});

router.get('/universities', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'GET /universities' });
});

router.post('/universities', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'POST /universities' });
});

router.get('/departments', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'GET /departments' });
});

router.post('/departments', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'POST /departments' });
});

router.get('/users', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'GET /users' });
});

router.get('/users/:id/schedule', (req, res) => {
  res.status(200).json({ status: 'ok', route: `GET /users/${req.params.id}/schedule` });
});

router.get('/users/:id/sections', (req, res) => {
  res.status(200).json({ status: 'ok', route: `GET /users/${req.params.id}/sections` });
});

router.patch('/users/:id/role', (req, res) => {
  res.status(200).json({ status: 'ok', route: `PATCH /users/${req.params.id}/role` });
});

router.patch('/users/:id/plan', (req, res) => {
  res.status(200).json({ status: 'ok', route: `PATCH /users/${req.params.id}/plan` });
});

router.patch('/versions/:id/set-latest', (req, res) => {
  res.status(200).json({ status: 'ok', route: `PATCH /versions/${req.params.id}/set-latest` });
});

export default router;
