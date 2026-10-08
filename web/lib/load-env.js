// web/lib/load-env.js
//
// Loads <repo root>/.env into process.env, exactly as web/shopify.js does for the
// web app. dotenv never overwrites a variable that is already set. Import this
// FIRST in an entry point that does not import shopify.js (the worker), because
// web/lib/prisma.js reads DATABASE_URL when it is imported.

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env') });
