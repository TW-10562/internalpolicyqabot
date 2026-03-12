import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Plus, Edit, Trash2, X, Save, Upload, Search } from 'lucide-react';
import { useLang } from '../../context/LanguageContext';
import { useToast } from '../../context/ToastContext';
import { formatDateTimeJP } from '../../lib/dateTime';
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
};

export interface UserManagementHandle {
  openCsvUpload: () => void;
  openAddUserModal: () => void;
  openBulkDeleteModal: () => void;
}

interface UserManagementProps {
  showTitle?: boolean;
  showControls?: boolean;
  showToolbar?: boolean;
  currentUser?: CurrentUser;
  searchQuery?: string;
  onSearchQueryChange?: (value: string) => void;
  onToolbarStateChange?: (state: { canBulkDelete: boolean; selectedCount: number; bulkDeleting: boolean }) => void;
}

const UserManagement = forwardRef<UserManagementHandle, UserManagementProps>(function UserManagement(
  {
    showTitle = true,
    showControls = true,
    showToolbar = true,
    currentUser,
    searchQuery: controlledSearchQuery,
    onSearchQueryChange,
    onToolbarStateChange,
  }: UserManagementProps,
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const loadUsersRequestRef = useRef(0);
  const [csvLoading, setCsvLoading] = useState(false);
  const [formData, setFormData] = useState<FormData>(initialFormData);
  const [userToDelete, setUserToDelete] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [csvSummary, setCsvSummary] = useState<CsvSummary | null>(null);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [internalSearchQuery, setInternalSearchQuery] = useState('');
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

  const uploadCsvLabel = getI18nLabel('userManagement.uploadCsv', 'Upload CSV');
  const addUserLabel = getI18nLabel('userManagement.form.addUserTitle', 'Add User');
  const searchQuery = controlledSearchQuery ?? internalSearchQuery;
  const setSearchQuery = onSearchQueryChange ?? setInternalSearchQuery;

  const loadUsers = async (query?: string) => {
    const q = String(query ?? activeSearch).trim();
    const requestId = ++loadUsersRequestRef.current;
    setLoading(true);
    setErrorMessage('');
    const response = await fetchAdminUsers(q);
    if (requestId !== loadUsersRequestRef.current) return;
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
    void loadUsers('');
  }, []);

  useEffect(() => {
    const normalizedQuery = searchQuery.trim();
    if (normalizedQuery === activeSearch) return;

    const timeoutId = window.setTimeout(() => {
      void loadUsers(searchQuery);
    }, 250);

    return () => window.clearTimeout(timeoutId);
  }, [searchQuery, activeSearch]);

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
      openBulkDeleteModal: () => handleBulkDelete(),
    }),
    [],
  );

  const buildPayload = () => {
    const email = formData.email.trim();
    const employeeCode = formData.employeeCode.trim();
    return {
      firstName: formData.firstName.trim(),
      lastName: formData.lastName.trim(),
      email,
      employeeCode,
      employeeId: employeeCode || email,
      roleCode: formData.roleCode,
      departmentCode: formData.departmentCode,
      isActive: formData.isActive,
      userJobRole: '',
      areaOfWork: '',
    };
  };

  const handleSaveNewUser = async () => {
    if (!formData.firstName || !formData.lastName || !formData.email) {
      return;
    }

    setErrorMessage('');
    const response = await createAdminUser(buildPayload());
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
      });
      setEditingUser(userId);
    }
  };

  const handleSaveEdit = async () => {
    if (!editingUser) return;
    setErrorMessage('');
    const response = await updateAdminUser(editingUser, buildPayload());
    if (response.code !== 200) {
      setErrorMessage(response.message || 'Failed to update user');
      return;
    }

    setEditingUser(null);
    setFormData(initialFormData);
    await loadUsers();
  };

  const handleCancelEdit = () => {
    setEditingUser(null);
    setFormData(initialFormData);
  };

  const handleDeleteUser = (userId: string) => {
    setUserToDelete(userId);
    setShowDeleteModal(true);
  };

  const confirmDelete = async () => {
    if (!userToDelete) return;
    setErrorMessage('');
    const response = await deleteAdminUser(userToDelete);
    if (response.code !== 200) {
      setErrorMessage(response.message || 'Failed to delete user');
      return;
    }

    setShowDeleteModal(false);
    setUserToDelete(null);
    await loadUsers();
  };

  const selectedCount = selectedUserIds.size;
  const allSelected = users.length > 0 && users.every((user) => selectedUserIds.has(user.id));
  const canBulkDelete = currentUser?.roleCode === 'SUPER_ADMIN';

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedCount > 0 && !allSelected;
    }
  }, [selectedCount, allSelected]);

  useEffect(() => {
    onToolbarStateChange?.({ canBulkDelete, selectedCount, bulkDeleting });
  }, [onToolbarStateChange, canBulkDelete, selectedCount, bulkDeleting]);

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
    return formatDateTimeJP(value, value || '-');
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
      {showTitle || (!editingUser && showToolbar) ? (
        <div
          className={`flex flex-wrap items-center gap-4 ${
            showTitle ? 'justify-between' : 'justify-end'
          }`}
        >
          {showTitle ? (
            <h3 className="app-page-title shrink-0 transition-colors">
              {t('userManagement.title')}
            </h3>
          ) : null}
          {!editingUser && showToolbar ? (
            <div className="ml-auto flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
              <div className="flex min-w-[280px] flex-1 items-center gap-3 rounded-2xl border border-default bg-surface px-3 py-3 shadow-sm transition-all duration-200 focus-within:border-primary focus-within:shadow-[0_0_0_4px_rgba(29,32,137,0.08)] dark:border-default dark:bg-dark-surface md:max-w-lg xl:max-w-xl">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-alt text-muted transition-colors dark:bg-dark-bg-primary dark:text-dark-text-muted">
                  <Search className={`h-4 w-4 ${loading ? 'animate-pulse' : ''}`} />
                </div>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={getI18nOrFallback('userManagement.search.placeholder', 'Search by name or email')}
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none transition-colors placeholder:text-muted dark:text-dark-text dark:placeholder:text-dark-text-muted"
                />
                {searchQuery ? (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-alt hover:text-foreground dark:text-dark-text-muted dark:hover:bg-dark-bg-primary dark:hover:text-dark-text"
                    aria-label={getI18nOrFallback('userManagement.search.clear', 'Clear')}
                  >
                    <X className="h-4 w-4" />
                  </button>
                ) : null}
              </div>

              {canBulkDelete && (
                <button
                  type="button"
                  onClick={handleBulkDelete}
                  disabled={selectedCount === 0 || bulkDeleting}
                  className="inline-flex shrink-0 items-center gap-2 rounded-xl btn-danger px-4 py-2.5 text-sm font-semibold text-on-accent transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  title={getI18nOrFallback('userManagement.bulkDelete.button', 'Bulk Delete')}
                >
                  <Trash2 className={`h-4 w-4 icon-current ${bulkDeleting ? 'animate-pulse' : ''}`} />
                  <span>{getI18nOrFallback('userManagement.bulkDelete.button', 'Bulk Delete')}</span>
                  {selectedCount > 0 ? (
                    <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs font-semibold">
                      {selectedCount}
                    </span>
                  ) : null}
                </button>
              )}
              {showControls && (
                <>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={csvLoading}
                    data-state={csvLoading ? 'loading' : 'idle'}
                    className="inline-flex shrink-0 items-center gap-2 rounded-xl btn-success px-4 py-2.5 text-sm font-semibold text-on-accent transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    title={uploadCsvLabel}
                  >
                    <Upload className={`h-4 w-4 icon-current ${csvLoading ? 'animate-pulse text-accent-strong' : ''}`} />
                    {csvLoading ? t('common.loading') : uploadCsvLabel}
                  </button>
                  <button
                    type="button"
                    onClick={handleAddUser}
                    className="inline-flex shrink-0 items-center gap-2 rounded-xl btn-primary px-4 py-2.5 text-sm font-semibold text-on-accent transition-colors"
                  >
                    <Plus className="h-4 w-4 icon-current" />
                    {addUserLabel}
                  </button>
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

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
              <th className="px-4 py-3 text-left text-sm font-medium text-muted dark:text-dark-text-muted transition-colors">{emailLabel}</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted dark:text-dark-text-muted transition-colors">{employeeCodeLabel}</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-[#6E7680] dark:text-dark-text-muted transition-colors">{t('userManagement.table.role')}</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-[#6E7680] dark:text-dark-text-muted transition-colors">{t('userManagement.table.department')}</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-[#6E7680] dark:text-dark-text-muted transition-colors">{t('userManagement.table.lastUpdated')}</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-[#6E7680] dark:text-dark-text-muted transition-colors">{t('userManagement.table.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-muted dark:text-dark-text-muted transition-colors">
                  {t('common.loading')}
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-muted dark:text-dark-text-muted transition-colors">
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
                        <input type="email" value={formData.email} onChange={(e) => setFormData({ ...formData, email: e.target.value })} className="w-full bg-surface dark:bg-dark-surface border border-default rounded px-2 py-1 text-foreground dark:text-dark-text text-sm focus:outline-none focus-ring-accent transition-colors" />
                      </td>
                      <td className="px-4 py-3">
                        <input type="text" value={formData.employeeCode} onChange={(e) => setFormData({ ...formData, employeeCode: e.target.value })} className="w-full bg-surface dark:bg-dark-surface border border-default rounded px-2 py-1 text-foreground dark:text-dark-text text-sm focus:outline-none focus-ring-accent transition-colors" />
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
                      <td className="px-4 py-3 text-[#6E7680] dark:text-dark-text-muted text-sm transition-colors">{formatDateTime(user.lastUpdated)}</td>
                      <td className="px-4 py-3 flex gap-2">
                        <button onClick={() => void handleSaveEdit()} className="p-1 text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-500/20 rounded transition-colors" title={t('userManagement.form.save')}><Save className="w-4 h-4" /></button>
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
                      <td className="px-4 py-3 text-[#6E7680] dark:text-dark-text-muted transition-colors">{user.email || '-'}</td>
                      <td className="px-4 py-3 text-[#6E7680] dark:text-dark-text-muted transition-colors">{user.employeeCode || '-'}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-1 rounded text-xs font-medium ${user.roleCode !== 'USER' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'} transition-colors`}>
                          {user.roleCode}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-[#6E7680] dark:text-dark-text-muted transition-colors">{user.departmentCode}</td>
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
              <input type="email" placeholder={emailLabel} value={formData.email} onChange={(e) => setFormData({ ...formData, email: e.target.value })} className="w-full bg-surface dark:bg-dark-surface-alt border border-default dark:border-default rounded-lg px-3 py-2 text-foreground dark:text-dark-text placeholder-muted dark:placeholder-dark-text-muted focus:outline-none focus-ring-accent transition-colors" />
              <input type="text" placeholder={employeeCodeLabel} value={formData.employeeCode} onChange={(e) => setFormData({ ...formData, employeeCode: e.target.value })} className="w-full bg-surface dark:bg-dark-surface-alt border border-default dark:border-default rounded-lg px-3 py-2 text-foreground dark:text-dark-text placeholder-muted dark:placeholder-dark-text-muted focus:outline-none focus-ring-accent transition-colors" />
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
            </div>

            <div className="flex gap-3 justify-end pt-4 border-t border-default dark:border-default transition-colors">
              <button onClick={() => setShowAddModal(false)} className="px-4 py-2 rounded-lg bg-surface dark:bg-dark-surface-alt hover:bg-surface-alt dark:hover:bg-dark-border text-foreground dark:text-dark-text text-sm font-medium transition-colors">{t('userManagement.form.cancel')}</button>
              <button onClick={handleSaveNewUser} className="px-4 py-2 rounded-lg btn-primary text-on-accent text-sm font-medium transition-colors">{t('userManagement.form.save')}</button>
            </div>
          </div>
        </div>
      )}

      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-surface dark:bg-dark-surface border border-default dark:border-default rounded-2xl p-6 max-w-md w-full mx-4 space-y-4 shadow-xl transition-colors">
            <h3 className="text-xl font-semibold text-foreground dark:text-white transition-colors">{getI18nOrFallback('userManagement.delete.confirmTitle', 'Confirm Delete')}</h3>
            <p className="text-muted dark:text-dark-text-muted text-sm transition-colors">{t('userManagement.delete.confirmMessage')}</p>

            <div className="flex gap-3 justify-end pt-4 border-t border-default dark:border-default transition-colors">
              <button onClick={() => { setShowDeleteModal(false); setUserToDelete(null); }} className="px-4 py-2 rounded-lg bg-surface dark:bg-dark-surface-alt hover:bg-surface-alt dark:hover:bg-dark-border text-foreground dark:text-dark-text text-sm font-medium transition-colors">{t('userManagement.form.cancel')}</button>
              <button onClick={() => void confirmDelete()} className="px-4 py-2 rounded-lg btn-danger disabled:opacity-50 disabled:cursor-not-allowed text-on-accent text-sm font-medium transition-colors">{t('userManagement.delete.confirmButton')}</button>
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
