/**
 * Phase 8: calendar, daily standups, global search.
 * Imported once at startup (src/modules/register.ts). Registers the search and calendar sources for
 * core data (tasks, projects, people); other modules register their own from their register.ts.
 */
import { registerCalendarSource, registerSearchSource } from '../../services/discovery';
import { calendarTasks, searchProjects, searchTasks, searchUsers } from './sources';

registerSearchSource('tasks', searchTasks);
registerSearchSource('projects', searchProjects);
registerSearchSource('users', searchUsers);
registerCalendarSource('tasks', calendarTasks);
