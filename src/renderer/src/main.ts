// Dentiva Pro renderer — bootstrap: register screens, then boot the shell.
import { boot, registerScreen } from './app';
import { dashboardScreen } from './screens/dashboard';
import { patientsScreen } from './screens/patients';
import { patientScreen } from './screens/patient360';
import { calendarScreen, queueScreen } from './screens/schedule';
import { billingScreen, invoiceScreen } from './screens/billing';
import { inventoryScreen } from './screens/inventory';
import { settingsScreen, usersScreen, backupScreen, auditScreen, treatmentsScreen, reportsScreen } from './screens/admin';

registerScreen('/dashboard', 'Overview', 'Dashboard', 'dashboard', () => dashboardScreen());
registerScreen('/patients', 'Clinical', 'Patients', 'patients', () => patientsScreen(new URLSearchParams(location.hash.split('?')[1] ?? '')));
registerScreen('/patient', 'Clinical', 'Patient 360', 'patients', () => patientScreen(new URLSearchParams(location.hash.split('?')[1] ?? '')));
registerScreen('/calendar', 'Clinical', 'Appointments', 'calendar', () => calendarScreen(new URLSearchParams(location.hash.split('?')[1] ?? '')));
registerScreen('/queue', 'Clinical', 'Queue', 'queue', () => queueScreen());
registerScreen('/billing', 'Finance', 'Billing', 'invoice', () => billingScreen(new URLSearchParams(location.hash.split('?')[1] ?? '')), ['admin', 'staff']);
registerScreen('/invoice', 'Finance', 'Invoice', 'invoice', () => invoiceScreen(new URLSearchParams(location.hash.split('?')[1] ?? '')), ['admin', 'staff']);
registerScreen('/inventory', 'Operations', 'Inventory', 'inventory', () => inventoryScreen());
registerScreen('/treatments', 'Operations', 'Treatments', 'chart', () => treatmentsScreen(), ['admin', 'dentist']);
registerScreen('/reports', 'Operations', 'Reports', 'reports', () => reportsScreen(), ['admin', 'dentist']);
registerScreen('/settings', 'Administration', 'Settings', 'settings', () => settingsScreen(), ['admin']);
registerScreen('/users', 'Administration', 'Staff', 'users', () => usersScreen(), ['admin']);
registerScreen('/backup', 'Administration', 'Backup', 'backup', () => backupScreen(), ['admin']);
registerScreen('/audit', 'Administration', 'Audit log', 'audit', () => auditScreen(), ['admin']);

// A hidden wildcard: unknown routes are handled by app.renderCurrent fallback to /dashboard.

void boot();
