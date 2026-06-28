import { supabase } from '../lib/supabase.js';

export const checkRole = (roles) => {
  const allowedRoles = Array.isArray(roles) ? roles : [roles];

  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(403).json({ error: 'no token provided' });
      }

      const token = authHeader.split(' ')[1];
      console.log('Token received:', token ? 'yes' : 'no');

      // STATIC ADMIN BYPASS (For FYP MVP testing)
      if (token === 'static-admin-token-syncwise') {
        req.user = {
          id: 'admin-001',
          email: 'admin@syncwise.com',
          role: 'admin',
          university_id: 'uni-001'
        };
        if (!allowedRoles.includes('admin')) {
          return res.status(403).json({ error: 'forbidden' });
        }
        return next();
      }

      // DEV TOKEN BYPASS (For Student/Teacher frontend testing)
      if (token === 'dev-token') {
        req.user = {
          id: 'dev-001',
          email: 'student@syncwise.com',
          role: 'student', // default to student for timetable fetching
          university_id: 'uni-001'
        };
        // allow if student or teacher is required, since dev-token is generic
        if (!allowedRoles.includes('student') && !allowedRoles.includes('teacher')) {
          // If the route strictly requires admin, but they use dev-token, we should reject or allow based on allowedRoles
          if (!allowedRoles.includes('admin')) {
             return res.status(403).json({ error: 'forbidden' });
          }
        }
        return next();
      }

      // Verify JWT
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      console.log('getUser result:', user ? user.id : 'null', authError?.message || '');
      
      if (authError || !user) {
        return res.status(403).json({ error: 'invalid token' });
      }

      // Fetch user from public.users
      const { data: userData, error: dbError } = await supabase
        .from('users')
        .select('id, email, role, plan, university_id')
        .eq('id', user.id)
        .single();

      console.log('DB user query result:', userData ? userData.role : 'not found');

      if (dbError || !userData) {
        return res.status(403).json({ error: 'user not found' });
      }

      // Check role
      if (!allowedRoles.includes(userData.role)) {
        return res.status(403).json({ 
          error: 'forbidden', 
          required: allowedRoles, 
          got: userData.role 
        });
      }

      // Attach user to request
      req.user = userData;
      next();
    } catch (error) {
      console.error('Role check error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
};
