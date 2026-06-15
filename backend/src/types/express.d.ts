/**
 * src/types/express.d.ts
 *
 * Augments Express's Request type with the fields our middleware attach.
 * Lets every handler use `req.userId` without a cast.
 */

import 'express';

declare global {
  namespace Express {
    interface Request {
      /**
       * Set by `authenticate` middleware after verifying the access token.
       * Undefined on unauthenticated routes.
       */
      userId?: string;
    }
  }
}

export {};
