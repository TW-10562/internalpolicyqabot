import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Plus, Edit, Trash2, X, Save, Upload } from 'lucide-react';
import { useLang } from '../../context/LanguageContext';
import { useToast } from '../../context/ToastContext';
import {
  bulkDeleteAdminUsers,
  createAdminUser,
  deleteAdminUser,
  fetchAdminUsers,
  importAdminUsersCsv,
  updateAdminUser,
} from '../../api/adminUsers';
import { User as CurrentUser } from '../../types';

interface User {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  employeeCode: string;
  roleCode: 'USER' | 'HR_ADMIN' | 'GA_ADMIN' | 'ACC_ADMIN' | 'SUPER_ADMIN';
  departmentCode: 'HR' | 'GA' | 'ACC' | 'SYSTEMS';
  isActive: boolean;
  lastUpdated: string;
}

interface FormData {
  firstName: string;
  lastName: string;
  email: string;
  employeeCode: string;
  roleCode: 'USER' | 'HR_ADMIN' | 'GA_ADMIN' | 'ACC_ADMIN' | 'SUPER_ADMIN';
  departmentCode: 'HR' | 'GA' | 'ACC' | 'SYSTEMS';
  isActive: boolean;
  password: string;
}

type CsvErrorItem = {
  row: number;
  field: string;
  value?: string;
  message: string;
};

type CsvSummary = {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  insertedCount?: number;
  errors?: CsvErrorItem[];
};

const looksLikeEmail = (value: string) => {
  const v = value.trim();
  return Boolean(v && v.includes('@') && v.includes('.') && !v.includes(' '));
};

const initialFormData: FormData = {
  firstName: '',
  lastName: '',
  email: '',
  employeeCode: '',
  roleCode: 'USER',
  departmentCode: 'HR',
  isActive: true,
  password: '',
};

export interface UserManagementHandle {
  openCsvUpload: () => void;
  openAddUserModal: () => void;
}

interface UserManagementProps {
  showTitle?: boolean;
  showControls?: boolean;
  currentUser?: CurrentUser;
}

const UserManagement = forwardRef<UserManagementHandle, UserManagementProps>(function UserManagement(
  { showTitle = true, showControls = true, currentUser }: UserManagementProps,
  ref,
) {
  const { t } = useLang();
  const toast = useToast();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showBulkDeleteModal, setShowBulkDeleteModal] = useState(false);
  const [showConfirmSave, setShowConfirmSave] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const [csvLoading, setCsvLoading] = useState(false);
  const [formData, setFormData] = useState<FormData>(initialFormData);
  const [userToDelete, setUserToDelete] = useState<string | null>(null);
  const [adminPassword, setAdminPassword] = useState('');
  const [editAdminPassword, setEditAdminPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [csvSummary, setCsvSummary] = useState<CsvSummary | null>(null);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSearch, setActiveSearch] = useState('');

  const getI18nLabel = (key: string, fallback: string) => {
    const translated = t(key);
    return translated === key ? fallback : translated;
  };

  const getI18nOrFallback = (key: string, fallback: string) => getI18nLabel(key, fallback);

  const firstNameLabel = getI18nOrFallback('userManagement.table.firstName', 'First name');
  const lastNameLabel = getI18nOrFallback('userManagement.table.lastName', 'Last name');
  const emailLabel = getI18nOrFallback('userManagement.table.email', 'Email');
  const employeeCodeLabel = getI18nOrFallback('userManagement.table.employeeCode', 'Employee Code');
  const passwordLabel = getI18nOrFallback('userManagement.table.password', 'Password');
  const optionalPasswordLabel = getI18nOrFallback('userManagement.password.changeOptional', 'Leave blank to keep');

  const uploadCsvLabel = getI18nLabel('userManagement.uploadCsv', 'Upload CSV');
  const addUserLabel = getI18nLabel('userManagement.form.addUserTitle', 'Add User');

  const loadUsers = async (query?: string) => {
    const q = String(query ?? activeSearch).trim();
    setLoading(true);
    setErrorMessage('');
    const response = await fetchAdminUsers(q);
    if (response.code !== 200) {
      setErrorMessage(response.message || 'Failed to fetch users');
      setLoading(false);
      return;
    }

    const mapped = (response.result || []).map((item) => {
      const apiEmail = String(item.email || '').trim();
      const apiEmp = String(item.emp_id || '').trim();
      const email = apiEmail || (looksLikeEmail(apiEmp) ? apiEmp : '');
      const employeeCode = apiEmail ? apiEmp : (looksLikeEmail(apiEmp) ? '' : apiEmp);

      return {
        id: String(item.user_id),
        firstName: item.first_name || '',
        lastName: item.last_name || '',
        email,
        employeeCode,
        roleCode: item.role_code || 'USER',
        departmentCode: item.department_code || 'HR',
        isActive: item.status === '1',
        lastUpdated: item.updated_at,
      };
    });

    setUsers(mapped);
    setActiveSearch(q);
    setSelectedUserIds((prev) => {
      if (prev.size === 0) return prev;
      const allowed = new Set(mapped.map((item) => item.id));
      const next = new Set([...prev].filter((id) => allowed.has(id)));
      return next;
    });
    setLoading(false);
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const handleCSVUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setCsvLoading(true);
    setErrorMessage('');
    setCsvSummary(null);

    const response = await importAdminUsersCsv(file);
    if (response.code !== 200) {
      const payload = response as any;
      const errors = Array.isArray(payload.errors) ? payload.errors : [];
      setErrorMessage(response.message || 'CSV upload failed');
      setCsvSummary({
        totalRows: Number(payload.totalRows ?? 0),
        validRows: Number(payload.validRows ?? 0),
        invalidRows: Number(payload.invalidRows ?? errors.length ?? 0),
        errors,
      });
      setCsvLoading(false);
      return;
    }

    const report = response.result as any;
    setCsvSummary({
      totalRows: Number(report?.totalRows ?? 0),
      validRows: Number(report?.validRows ?? 0),
      invalidRows: Number(report?.invalidRows ?? 0),
      insertedCount: Number(report?.insertedCount ?? 0),
      errors: [],
    });
    toast.success(
      getI18nOrFallback('userManagement.csvSummary.successTitle', 'CSV imported'),
      t('userManagement.csvSummary.successMessage', { count: Number(report?.insertedCount ?? 0) }, 'Inserted {{count}} users'),
    );
    await loadUsers();
    setCsvLoading(false);

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleAddUser = () => {
    setFormData(initialFormData);
    setShowAddModal(true);
  };

  useImperativeHandle(
    ref,
    () => ({
      openCsvUpload: () => fileInputRef.current?.click(),
      openAddUserModal: () => handleAddUser(),
    }),
    [],
  );

  const buildPayload = (passwordOptional = false) => {
    const email = formData.email.trim();
    const employeeCode = formData.employeeCode.trim();
    const payload: any = {
      firstName: formData.firstName.trim(),
      lastName: formData.lastName.trim(),
      email,
      employeeCode,
      // Backend still uses employeeId for emp_id (employee code). Send a fallback for compatibility.
      employeeId: employeeCode || email,
      userJobRole: '',
      areaOfWork: '',
      roleCode: formData.roleCode,
      departmentCode: formData.departmentCode,
      isActive: formData.isActive,
    };

    if (!passwordOptional || formData.password.trim()) {
      payload.password = formData.password;
    }

    return payload;
  };

  const handleSaveNewUser = async () => {
    if (!formData.firstName || !formData.lastName || !formData.email || !formData.password) {
      return;
    }

    setErrorMessage('');
    const response = await createAdminUser(buildPayload(false));
    if (response.code !== 200) {
      setErrorMessage(response.message || 'Failed to create user');
      return;
    }

    setShowAddModal(false);
    setFormData(initialFormData);
    await loadUsers();
  };

  const handleEditUser = (userId: string) => {
    const user = users.find((u) => u.id === userId);
    if (user) {
      setFormData({
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        employeeCode: user.employeeCode,
        roleCode: user.roleCode,
        departmentCode: user.departmentCode,
        isActive: user.isActive,
        password: '',
      });
      setEditingUser(userId);
    }
  };

  const handleSaveEdit = () => {
    if (editingUser) {
      setShowConfirmSave(true);
    }
  };

  const confirmSaveEdit = async () => {
    if (editingUser && editAdminPassword.trim()) {
      setErrorMessage('');
      const response = await updateAdminUser(editingUser, buildPayload(true));
      if (response.code !== 200) {
        setErrorMessage(response.message || 'Failed to update user');
        return;
      }

      setEditingUser(null);
      setShowConfirmSave(false);
      setEditAdminPassword('');
      setFormData(initialFormData);
      await loadUsers();
    }
  };

  const handleCancelEdit = () => {
    setEditingUser(null);
    setEditAdminPassword('');
    setFormData(initialFormData);
  };

  const handleDeleteUser = (userId: string) => {
    setUserToDelete(userId);
    setShowDeleteModal(true);
    setAdminPassword('');
  };

  const confirmDelete = async () => {
    if (userToDelete && adminPassword.trim()) {
      setErrorMessage('');
      const response = await deleteAdminUser(userToDelete);
      if (response.code !== 200) {
        setErrorMessage(response.message || 'Failed to delete user');
        return;
      }

      setShowDeleteModal(false);
      setUserToDelete(null);
      setAdminPassword('');
      await loadUsers();
    }
  };

  const selectedCount = selectedUserIds.size;
  const allSelected = users.length > 0 && users.every((user) => selectedUserIds.has(user.id));
  const canBulkDelete = currentUser?.roleCode === 'SUPER_ADMIN';

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedCount > 0 && !allSelected;
    }
  }, [selectedCount, allSelected]);

  const toggleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedUserIds(new Set(users.map((user) => user.id)));
    } else {
      setSelectedUserIds(new Set());
    }
  };

  const toggleSelectUser = (userId: string) => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  const handleBulkDelete = () => {
    if (!canBulkDelete || selectedUserIds.size === 0) return;
    setShowBulkDeleteModal(true);
  };

  const confirmBulkDelete = async () => {
    if (!canBulkDelete) return;
    const selectedIds = Array.from(selectedUserIds);
    if (selectedIds.length === 0) return;

    setBulkDeleting(true);
    setErrorMessage('');
    const response = await bulkDeleteAdminUsers(selectedIds);
    if (response.code !== 200) {
      const message = response.message || 'Failed to delete users';
      setErrorMessage(message);
      toast.error(getI18nOrFallback('userManagement.bulkDelete.errorTitle', 'Bulk delete failed'), message);
      setBulkDeleting(false);
      return;
    }

    const deletedCount = response.result?.deletedCount ?? selectedIds.length;
    toast.success(
      getI18nOrFallback('userManagement.bulkDelete.successTitle', 'Bulk delete complete'),
      t('userManagement.bulkDelete.successMessage', { count: deletedCount }, 'Deleted {{count}} users'),
    );
    setShowBulkDeleteModal(false);
    setSelectedUserIds(new Set());
    setBulkDeleting(false);
    await loadUsers();
  };

  const formatDateTime = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || '-';
    return date.toLocaleString();
  };

  return (
    <div className="space-y-4">
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv"
        onChange={handleCSVUpload}
        className="hidden"
      />
      <div
        className={`flex items-center gap-2 ${
          showTitle ? 'justify-between' : 'justify-end'
        }`}
      >
        {showTitle ? (
          <h3 className="app-page-title transition-colors">
            {t('userManagement.title')}
          </h3>
        ) : null}
        {!editingUser && (
          <div className="flex items-center gap-2">
            {showControls && (
              <>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={csvLoading}
                  data-state={csvLoading ? 'loading' : 'idle'}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg btn-success disabled:opacity-50 disabled:cursor-not-allowed text-on-accent text-sm font-medium transition-colors"
                  title={uploadCsvLabel}
                >
                  <Upload className={`w-4 h-4 icon-current ${csvLoading ? 'animate-pulse text-accent-strong' : ''}`} />
                  {csvLoading ? t('common.loading') : uploadCsvLabel}
                </button>
                <button
                  onClick={handleAddUser}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg btn-primary text-on-accent text-sm font-medium transition-colors"
                >
                  <Plus className="w-4 h-4 icon-current" />
                  {addUserLabel}
                </button>
              </>
            )}
            {canBulkDelete && (
              <button
                onClick={handleBulkDelete}
                disabled={selectedCount === 0 || bulkDeleting}
                className="flex items-center gap-2 px-4 py-2 rounded-lg btn-danger disabled:opacity-50 disabled:cursor-not-allowed text-on-accent text-sm font-medium transition-colors"
                title={getI18nOrFallback('userManagement.bulkDelete.button', 'Bulk Delete')}
              >
                <Trash2 className={`w-4 h-4 icon-current ${bulkDeleting ? 'animate-pulse' : ''}`} />
                {getI18nOrFallback('userManagement.bulkDelete.button', 'Bulk Delete')}
                {selectedCount > 0 ? ` (${selectedCount})` : ''}
              </button>
            )}
          </div>
        )}
      </div>

      {errorMessage && (
        <div className="px-4 py-3 rounded-lg bg-red-50 text-red-700 border border-red-200 text-sm">
          {errorMessage}
        </div>
      )}

      {csvSummary && (
        <div className="px-4 py-3 rounded-lg bg-surface-alt dark:bg-dark-bg-primary border border-default dark:border-default text-sm space-y-2">
          <div className="font-medium text-foreground dark:text-dark-text">
            {getI18nOrFallback('userManagement.csvSummary.title', 'CSV Import Summary')}
          </div>
          <div className="flex flex-wrap gap-4 text-muted dark:text-dark-text-muted">
            <div>
              {getI18nOrFallback('userManagement.csvSummary.totalRows', 'Total rows')}: {csvSummary.totalRows}
            </div>
            <div>
              {getI18nOrFallback('userManagement.csvSummary.validRows', 'Valid rows')}: {csvSummary.validRows}
            </div>
            <div>
              {getI18nOrFallback('userManagement.csvSummary.invalidRows', 'Invalid rows')}: {csvSummary.invalidRows}
            </div>
            {csvSummary.insertedCount != null ? (
              <div>
                {getI18nOrFallback('userManagement.csvSummary.insertedRows', 'Inserted')}: {csvSummary.insertedCount}
              </div>
            ) : null}
          </div>
          {csvSummary.errors && csvSummary.errors.length > 0 ? (
            <div className="text-sm">
              <div className="font-medium text-red-700">
                {getI18nOrFallback('userManagement.csvSummary.errorTitle', 'Errors')}
              </div>
              <ul className="mt-2 max-h-40 overflow-auto list-disc pl-5 text-red-700">
                {csvSummary.errors.map((err, index) => (
                  <li key={`${err.row}-${err.field}-${index}`}>
                    {t('userManagement.csvSummary.rowLabel', { row: err.row }, 'Row {{row}}')}: {err.field} - {err.message}
                    {err.value ? ` (${err.value})` : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}

      <div className="bg-surface dark:bg-dark-surface border border-default dark:border-default rounded-2xl overflow-hidden shadow-sm transition-colors">
        <table className="w-full">
          <thead className="bg-surface-alt dark:bg-dark-bg-primary border-b border-default dark:border-default transition-colors">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted dark:text-dark-text-muted transition-colors">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) => toggleSelectAll(e.target.checked)}
                  disabled={users.length === 0 || loading || bulkDeleting}
                  aria-label={getI18nOrFallback('userManagement.table.selectAll', 'Select all')}
                  className="h-4 w-4 rounded border-default text-accent-strong focus:ring-2 focus:ring-accent-strong"
                />
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted dark:text-dark-text-muted transition-colors">{t('userManagement.table.firstName')}</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted dark:text-dark-text-muted transition-colors">{t('userManagement.table.lastName')}</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted dark:text-dark-text-muted transition-colors">{t('userManagement.table.employeeId')}</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted dark:text-dark-text-muted transition-colors">{t('userManagement.table.userJobRole')}</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted dark:text-dark-text-muted transition-colors">{t('userManagement.table.areaOfWork')}</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-[#6E7680] dark:text-dark-text-muted transition-colors">{t('userManagement.table.role')}</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-[#6E7680] dark:text-dark-text-muted transition-colors">{t('userManagement.table.department')}</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-[#6E7680] dark:text-dark-text-muted transition-colors">{t('userManagement.table.password')}</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-[#6E7680] dark:text-dark-text-muted transition-colors">{t('userManagement.table.lastUpdated')}</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-[#6E7680] dark:text-dark-text-muted transition-colors">{t('userManagement.table.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-muted dark:text-dark-text-muted transition-colors">
                  {t('common.loading')}
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-muted dark:text-dark-text-muted transition-colors">
                  {t('userManagement.empty')}
                </td>
              </tr>
            ) : (
              users.map((user) => (
                <tr key={user.id} className="border-b border-default dark:border-default hover:bg-surface-alt dark:hover:bg-dark-border transition-colors">
                  {editingUser === user.id ? (
                    <>
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedUserIds.has(user.id)}
                          onChange={() => toggleSelectUser(user.id)}
                          disabled={bulkDeleting}
                          aria-label={getI18nOrFallback('userManagement.table.selectUser', 'Select user')}
                          className="h-4 w-4 rounded border-default text-accent-strong focus:ring-2 focus:ring-accent-strong"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <input type="text" value={formData.firstName} onChange={(e) => setFormData({ ...formData, firstName: e.target.value })} className="w-full bg-surface dark:bg-dark-surface border border-default dark:border-default rounded px-2 py-1 text-foreground dark:text-dark-text text-sm focus:outline-none focus-ring-accent transition-colors" />
                      </td>
                      <td className="px-4 py-3">
                        <input type="text" value={formData.lastName} onChange={(e) => setFormData({ ...formData, lastName: e.target.value })} className="w-full bg-surface dark:bg-dark-surface border border-default rounded px-2 py-1 text-foreground dark:text-dark-text text-sm focus:outline-none focus-ring-accent transition-colors" />
                      </td>
                      <td className="px-4 py-3">
                        <input type="text" value={formData.employeeId} onChange={(e) => setFormData({ ...formData, employeeId: e.target.value })} className="w-full bg-surface dark:bg-dark-surface border border-default rounded px-2 py-1 text-foreground dark:text-dark-text text-sm focus:outline-none focus-ring-accent transition-colors" />
                      </td>
                      <td className="px-4 py-3">
                        <select value={formData.userJobRole} onChange={(e) => setFormData({ ...formData, userJobRole: e.target.value })} className="w-full bg-surface dark:bg-dark-surface border border-default dark:border-default rounded px-2 py-1 text-foreground dark:text-dark-text text-sm focus:outline-none focus-ring-accent transition-colors">
                          <option value="">{selectJobRoleLabel}</option>
                          {JOB_ROLE_OPTIONS.map((option) => (
                            <option key={option.key} value={option.key}>{getJobRoleLabel(option.key)}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <select value={formData.areaOfWork} onChange={(e) => setFormData({ ...formData, areaOfWork: e.target.value })} className="w-full bg-surface dark:bg-dark-surface border border-default dark:border-default rounded px-2 py-1 text-foreground dark:text-dark-text text-sm focus:outline-none focus-ring-accent transition-colors">
                          <option value="">{selectAreaLabel}</option>
                          {AREA_OF_WORK_OPTIONS.map((option) => (
                            <option key={option.key} value={option.key}>{getAreaLabel(option.key)}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <select value={formData.roleCode} onChange={(e) => setFormData({ ...formData, roleCode: e.target.value as FormData['roleCode'] })} className="w-full bg-surface dark:bg-dark-surface border border-default rounded px-2 py-1 text-foreground dark:text-dark-text text-sm focus:outline-none focus-ring-accent transition-colors">
                          <option value="USER">USER</option>
                          <option value="HR_ADMIN">HR_ADMIN</option>
                          <option value="GA_ADMIN">GA_ADMIN</option>
                          <option value="ACC_ADMIN">ACC_ADMIN</option>
                          <option value="SUPER_ADMIN">SUPER_ADMIN</option>
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <select value={formData.departmentCode} onChange={(e) => setFormData({ ...formData, departmentCode: e.target.value as FormData['departmentCode'] })} className="w-full bg-surface dark:bg-dark-surface border border-default rounded px-2 py-1 text-foreground dark:text-dark-text text-sm focus:outline-none focus-ring-accent transition-colors">
                          <option value="HR">HR</option>
                          <option value="GA">GA</option>
                          <option value="ACC">ACC</option>
                          <option value="SYSTEMS">SYSTEMS</option>
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <input type="password" value={formData.password} onChange={(e) => setFormData({ ...formData, password: e.target.value })} placeholder={optionalPasswordLabel} className="w-full bg-white dark:bg-dark-surface border border-[#E8E8E8] dark:border-dark-border rounded px-2 py-1 text-[#232333] dark:text-dark-text text-sm focus:outline-none focus:ring-2 focus:ring-[#1d2089] dark:focus:ring-dark-accent-blue transition-colors" />
                      </td>
                      <td className="px-4 py-3 text-[#6E7680] dark:text-dark-text-muted text-sm transition-colors">{formatDateTime(user.lastUpdated)}</td>
                      <td className="px-4 py-3 flex gap-2">
                        <button onClick={handleSaveEdit} className="p-1 text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-500/20 rounded transition-colors" title={t('userManagement.form.save')}><Save className="w-4 h-4" /></button>
                        <button onClick={handleCancelEdit} className="p-1 text-icon-muted dark:text-dark-text-muted hover:bg-surface hover:dark:bg-white/10 rounded transition-colors" title={t('userManagement.form.cancel')}><X className="w-4 h-4" /></button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedUserIds.has(user.id)}
                          onChange={() => toggleSelectUser(user.id)}
                          disabled={bulkDeleting}
                          aria-label={getI18nOrFallback('userManagement.table.selectUser', 'Select user')}
                          className="h-4 w-4 rounded border-default text-accent-strong focus:ring-2 focus:ring-accent-strong"
                        />
                      </td>
                      <td className="px-4 py-3 text-[#232333] dark:text-dark-text font-medium transition-colors">{user.firstName}</td>
                      <td className="px-4 py-3 text-[#232333] dark:text-dark-text font-medium transition-colors">{user.lastName}</td>
                      <td className="px-4 py-3 text-[#6E7680] dark:text-dark-text-muted transition-colors">{user.employeeId}</td>
                      <td className="px-4 py-3 text-[#6E7680] dark:text-dark-text-muted transition-colors">{getJobRoleLabel(user.userJobRole)}</td>
                      <td className="px-4 py-3 text-[#6E7680] dark:text-dark-text-muted transition-colors">{getAreaLabel(user.areaOfWork)}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-1 rounded text-xs font-medium ${user.roleCode !== 'USER' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'} transition-colors`}>
                          {user.roleCode}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-[#6E7680] dark:text-dark-text-muted transition-colors">{user.departmentCode}</td>
                      <td className="px-4 py-3 text-[#6E7680] dark:text-dark-text-muted transition-colors">••••••</td>
                      <td className="px-4 py-3 text-[#6E7680] dark:text-dark-text-muted text-sm transition-colors">{formatDateTime(user.lastUpdated)}</td>
                      <td className="px-4 py-3 flex gap-2">
                        <button onClick={() => handleEditUser(user.id)} className="p-1 text-blue-600 dark:text-dark-accent-blue hover:bg-blue-50 dark:hover:bg-blue-500/20 rounded transition-colors" title={t('userManagement.form.edit')}><Edit className="w-4 h-4" /></button>
                        <button onClick={() => handleDeleteUser(user.id)} className="p-1 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/20 rounded transition-colors" title={t('userManagement.form.delete')}><Trash2 className="w-4 h-4" /></button>
                      </td>
                    </>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-surface dark:bg-dark-surface border border-default dark:border-default rounded-2xl p-6 max-w-md w-full mx-4 space-y-4 shadow-xl transition-colors">
            <h3 className="text-xl font-semibold text-foreground dark:text-white transition-colors">{t('userManagement.form.addUserTitle')}</h3>

            <div className="space-y-3">
              <input type="text" placeholder={firstNameLabel} value={formData.firstName} onChange={(e) => setFormData({ ...formData, firstName: e.target.value })} className="w-full bg-surface dark:bg-dark-surface-alt border border-default dark:border-default rounded-lg px-3 py-2 text-foreground dark:text-dark-text placeholder-muted dark:placeholder-dark-text-muted focus:outline-none focus-ring-accent transition-colors" />
              <input type="text" placeholder={lastNameLabel} value={formData.lastName} onChange={(e) => setFormData({ ...formData, lastName: e.target.value })} className="w-full bg-surface dark:bg-dark-surface-alt border border-default dark:border-default rounded-lg px-3 py-2 text-foreground dark:text-dark-text placeholder-muted dark:placeholder-dark-text-muted focus:outline-none focus-ring-accent transition-colors" />
              <input type="text" placeholder={employeeIdLabel} value={formData.employeeId} onChange={(e) => setFormData({ ...formData, employeeId: e.target.value })} className="w-full bg-surface dark:bg-dark-surface-alt border border-default dark:border-default rounded-lg px-3 py-2 text-foreground dark:text-dark-text placeholder-muted dark:placeholder-dark-text-muted focus:outline-none focus-ring-accent transition-colors" />
              <select value={formData.userJobRole} onChange={(e) => setFormData({ ...formData, userJobRole: e.target.value })} className="w-full bg-surface dark:bg-dark-surface-alt border border-default dark:border-default rounded-lg px-3 py-2 text-foreground dark:text-dark-text focus:outline-none focus-ring-accent transition-colors">
                <option value="">{selectJobRoleLabel}</option>
                {JOB_ROLE_OPTIONS.map((option) => (
                  <option key={option.key} value={option.key}>{getJobRoleLabel(option.key)}</option>
                ))}
              </select>
              <select value={formData.areaOfWork} onChange={(e) => setFormData({ ...formData, areaOfWork: e.target.value })} className="w-full bg-surface dark:bg-dark-surface-alt border border-default dark:border-default rounded-lg px-3 py-2 text-foreground dark:text-dark-text focus:outline-none focus-ring-accent transition-colors">
                <option value="">{selectAreaLabel}</option>
                {AREA_OF_WORK_OPTIONS.map((option) => (
                  <option key={option.key} value={option.key}>{getAreaLabel(option.key)}</option>
                ))}
              </select>
              <select value={formData.roleCode} onChange={(e) => setFormData({ ...formData, roleCode: e.target.value as FormData['roleCode'] })} className="w-full bg-surface dark:bg-dark-surface-alt border border-default dark:border-default rounded-lg px-3 py-2 text-foreground dark:text-dark-text focus:outline-none focus-ring-accent transition-colors">
                <option value="USER">USER</option>
                <option value="HR_ADMIN">HR_ADMIN</option>
                <option value="GA_ADMIN">GA_ADMIN</option>
                <option value="ACC_ADMIN">ACC_ADMIN</option>
                <option value="SUPER_ADMIN">SUPER_ADMIN</option>
              </select>
              <select value={formData.departmentCode} onChange={(e) => setFormData({ ...formData, departmentCode: e.target.value as FormData['departmentCode'] })} className="w-full bg-surface dark:bg-dark-surface-alt border border-default dark:border-default rounded-lg px-3 py-2 text-foreground dark:text-dark-text focus:outline-none focus-ring-accent transition-colors">
                <option value="HR">HR</option>
                <option value="GA">GA</option>
                <option value="ACC">ACC</option>
                <option value="SYSTEMS">SYSTEMS</option>
              </select>
              <input type="password" placeholder={passwordLabel} value={formData.password} onChange={(e) => setFormData({ ...formData, password: e.target.value })} className="w-full bg-surface dark:bg-dark-surface-alt border border-default dark:border-default rounded-lg px-3 py-2 text-foreground dark:text-dark-text placeholder-muted dark:placeholder-dark-text-muted focus:outline-none focus-ring-accent transition-colors" />
            </div>

            <div className="flex gap-3 justify-end pt-4 border-t border-default dark:border-default transition-colors">
              <button onClick={() => setShowAddModal(false)} className="px-4 py-2 rounded-lg bg-surface dark:bg-dark-surface-alt hover:bg-surface-alt dark:hover:bg-dark-border text-foreground dark:text-dark-text text-sm font-medium transition-colors">{t('userManagement.form.cancel')}</button>
              <button onClick={handleSaveNewUser} className="px-4 py-2 rounded-lg btn-primary text-on-accent text-sm font-medium transition-colors">{t('userManagement.form.save')}</button>
            </div>
          </div>
        </div>
      )}

      {showConfirmSave && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-surface dark:bg-dark-surface border border-default dark:border-default rounded-2xl p-6 max-w-md w-full mx-4 space-y-4 shadow-xl transition-colors">
            <h3 className="text-xl font-semibold text-foreground dark:text-white transition-colors">{t('userManagement.delete.confirmTitle')}</h3>
            <p className="text-muted dark:text-dark-text-muted text-sm transition-colors">{t('userManagement.form.editUserTitle')}</p>

            <input type="password" placeholder={t('userManagement.delete.adminPassword')} value={editAdminPassword} onChange={(e) => setEditAdminPassword(e.target.value)} className="w-full bg-surface dark:bg-dark-surface-alt border border-default dark:border-default rounded-lg px-3 py-2 text-foreground dark:text-dark-text placeholder-muted dark:placeholder-dark-text-muted focus:outline-none focus-ring-accent transition-colors" />

            <div className="flex gap-3 justify-end pt-4 border-t border-default dark:border-default transition-colors">
              <button onClick={() => { setShowConfirmSave(false); setEditAdminPassword(''); }} className="px-4 py-2 rounded-lg bg-surface dark:bg-dark-surface-alt hover:bg-surface-alt dark:hover:bg-dark-border text-foreground dark:text-dark-text text-sm font-medium transition-colors">{t('userManagement.form.cancel')}</button>
              <button onClick={confirmSaveEdit} disabled={!editAdminPassword.trim()} className="px-4 py-2 rounded-lg btn-success text-on-accent text-sm font-medium transition-colors">{t('userManagement.form.save')}</button>
            </div>
          </div>
        </div>
      )}

      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-surface dark:bg-dark-surface border border-default dark:border-default rounded-2xl p-6 max-w-md w-full mx-4 space-y-4 shadow-xl transition-colors">
            <h3 className="text-xl font-semibold text-foreground dark:text-white transition-colors">{t('userManagement.delete.adminPassword')}</h3>
            <p className="text-muted dark:text-dark-text-muted text-sm transition-colors">{t('userManagement.delete.confirmMessage')}</p>

            <input type="password" placeholder={t('userManagement.delete.adminPassword')} value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} className="w-full bg-surface dark:bg-dark-surface-alt border border-default dark:border-default rounded-lg px-3 py-2 text-foreground dark:text-dark-text placeholder-muted dark:placeholder-dark-text-muted focus:outline-none focus-ring-accent transition-colors" />

            <div className="flex gap-3 justify-end pt-4 border-t border-default dark:border-default transition-colors">
              <button onClick={() => { setShowDeleteModal(false); setUserToDelete(null); setAdminPassword(''); }} className="px-4 py-2 rounded-lg bg-surface dark:bg-dark-surface-alt hover:bg-surface-alt dark:hover:bg-dark-border text-foreground dark:text-dark-text text-sm font-medium transition-colors">{t('userManagement.form.cancel')}</button>
              <button onClick={confirmDelete} disabled={!adminPassword.trim()} className="px-4 py-2 rounded-lg btn-danger disabled:opacity-50 disabled:cursor-not-allowed text-on-accent text-sm font-medium transition-colors">{t('userManagement.delete.confirmButton')}</button>
            </div>
          </div>
        </div>
      )}

      {showBulkDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-surface dark:bg-dark-surface border border-default dark:border-default rounded-2xl p-6 max-w-md w-full mx-4 space-y-4 shadow-xl transition-colors">
            <h3 className="text-xl font-semibold text-foreground dark:text-white transition-colors">
              {getI18nOrFallback('userManagement.bulkDelete.confirmTitle', 'Confirm Bulk Delete')}
            </h3>
            <p className="text-muted dark:text-dark-text-muted text-sm transition-colors">
              {t(
                'userManagement.bulkDelete.confirmMessage',
                { count: selectedCount },
                'Are you sure you want to delete {{count}} selected users?',
              )}
            </p>

            <div className="flex gap-3 justify-end pt-4 border-t border-default dark:border-default transition-colors">
              <button
                onClick={() => setShowBulkDeleteModal(false)}
                disabled={bulkDeleting}
                className="px-4 py-2 rounded-lg bg-surface dark:bg-dark-surface-alt hover:bg-surface-alt dark:hover:bg-dark-border text-foreground dark:text-dark-text text-sm font-medium transition-colors"
              >
                {t('userManagement.form.cancel')}
              </button>
              <button
                onClick={confirmBulkDelete}
                disabled={bulkDeleting}
                className="px-4 py-2 rounded-lg btn-danger disabled:opacity-50 disabled:cursor-not-allowed text-on-accent text-sm font-medium transition-colors"
              >
                {bulkDeleting
                  ? getI18nOrFallback('userManagement.bulkDelete.deleting', 'Deleting...')
                  : getI18nOrFallback('userManagement.bulkDelete.confirmButton', 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default UserManagement;
