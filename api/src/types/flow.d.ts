import { StringDataType } from 'sequelize';

/* global OpTypes */
export interface IFlowDefinitionsQueryType {
  pageNum: number;
  pageSize: number;
  createBy?: string;
  updateBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface IFlowDefinitionsQuerySerType {
  pageNum: number;
  pageSize: number;
  create_By: string;
}

export interface IFlowDefinitonsTask {
  id?: string;
  name: string;
  description: string;
  json_schema: JSON
}


export interface IFlowDefinitonsSer {
  id?: string;
  name?: string;
  description?: string;
  json_schema?: JSON;
  create_by?: string;
  update_by?: string;
  created_at?: string;
  updated_at?: string;
}
