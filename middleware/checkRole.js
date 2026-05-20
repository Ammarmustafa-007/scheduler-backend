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

      // Verify JWT
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      
      if (authError || !user) {
        return res.status(403).json({ error: 'invalid token' });
      }

      // Fetch user from public.users
      const { data: userData, error: dbError } = await supabase
        .from('users')
        .select('id, email, role, plan, university_id')
        .eq('id', user.id)
        .single();

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
