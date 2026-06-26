/**
 * src/types/express.d.ts
 *
 * Augments Express's Request type with the fields our middleware attach.
 * Lets every handler access req.userId and req.requestId without casts.
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

      /**
       * Set by `requestLogger` middleware at the very start of each request.
       * Always present (requestLogger is mounted before all routes in app.ts).
       * Echoed back in every error response under `meta.request_id` so a
       * user-reported error can be correlated to a log line without PII.
       */
      requestId?: string;
    }
  }
}

export {};
