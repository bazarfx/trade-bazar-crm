export const VIEW_SCOPES = ['NONE', 'OWN', 'GROUP', 'DEPARTMENT', 'ALL'] as const;
export type ViewScope = (typeof VIEW_SCOPES)[number];

export const SPECIAL_PERMISSIONS = [
  'REASSIGN_LEADS', 'TRANSFER_DEAL_OWNERSHIP', 'MANAGE_FIELDS_LAYOUTS',
  'MANAGE_STATUSES', 'MANAGE_USERS_ROLES', 'MANAGE_DEPARTMENTS_GROUPS',
  'MANAGE_CAMPAIGNS', 'IMPORT_EXPORT', 'BULK_OPERATIONS', 'VIEW_AUDIT_LOGS',
] as const;
export type SpecialPermission = (typeof SPECIAL_PERMISSIONS)[number];

/** Human labels for the permission matrix UI. */
export const SPECIAL_PERMISSION_LABELS: Record<SpecialPermission, string> = {
  REASSIGN_LEADS:            'Reassign leads',
  TRANSFER_DEAL_OWNERSHIP:   'Transfer deal ownership',
  MANAGE_FIELDS_LAYOUTS:     'Manage fields & layouts',
  MANAGE_STATUSES:           'Manage statuses',
  MANAGE_USERS_ROLES:        'Manage users & roles',
  MANAGE_DEPARTMENTS_GROUPS: 'Manage departments & groups',
  MANAGE_CAMPAIGNS:          'Manage campaigns',
  IMPORT_EXPORT:             'Import / Export',
  BULK_OPERATIONS:           'Bulk operations',
  VIEW_AUDIT_LOGS:           'View audit logs',
};

export type RecordAction = 'view' | 'create' | 'edit' | 'delete';

export interface ActorContext {
  userId: string;
  roleId: string;
  departmentId: string | null;
  groupIds: string[];
  isAdmin: boolean;
}
