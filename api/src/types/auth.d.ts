export interface IuserTokenType {
  userId: number;
  userName: string;
  empId?: string;
  roleCode?: string;
  departmentCode?: string;
  session: string;
  exp: number;
  iat: number;
}
