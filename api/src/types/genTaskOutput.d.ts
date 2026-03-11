/* global OpTypes */
export interface IGenTaskOutputQueryType {
  pageNum: number;
  pageSize: number;
  taskId?: string;
  sort?: number;
  status?: string;
  feedback?: string;
  createBy?: string;
  updateBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface IGenTaskOutputQuerySerType {
  pageNum: number;
  pageSize: number;
  task_id?: { [OpTypes.eq]: string };
  status?: { [OpTypes.eq]: string };
  feedback?: { [OpTypes.eq]: string };
  sort?: number;
  department_code?: string;
}

export interface IGenTaskOutput {
  taskId?: string;
  metadata?: string;
  content?: string;
  status?: string;
  feedback?: string;
}

export interface IGenTaskOutputSer {
  id?: number;
  task_id?: string;
  metadata?: string;
  content?: string;
  status?: string;
  feedback?: string;
  del_flag?: string;
  create_by?: string;
  update_by?: string;
  department_code?: string;
  created_at?: string;
  updated_at?: string;
}

export interface IGenTaskOutputReNameSer {
  id?: number;
  task_id?: string;
  form_data?: string;
  updated_at?: string;
}
