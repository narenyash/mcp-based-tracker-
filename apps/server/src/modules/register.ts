/**
 * Module registrations (entity resolvers, socket handlers, event listeners). Imported once by app.ts,
 * so they are in place for the HTTP server, the worker and tests alike.
 */
import './tasks/tasks.entity';
import './tickets/register';
import './collab/register';
import './goals/register';
import './boards/register';
import './planning/register';
import './reports/register';
