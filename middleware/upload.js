import multer from 'multer';

// Multer configuration for PDF uploads (memory storage, 25MB limit)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

export { upload };
