import { IChatTaskFormData } from '@/service/krd/chatTask';
import { IImageGenFormData } from '@/service/krd/imageGenTask';
import { ILongTextGenFormData } from '@/service/krd/longTextGenTask';
import { IQuestionGenFormData } from '@/service/krd/questionGenTask';
import { ISearchTaskFormData } from '@/service/krd/searchTask';
import { IVoiceGenFormData } from '@/service/krd/voiceGenTask';
import { StringDataType } from 'sequelize';

/* global OpTypes */
export interface IGenTaskQueryType {
  pageNum: number;
  pageSize: number;
  type?: string;
  status?: string;
  createBy?: string;
  updateBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface IGenTaskQuerySerType {
  pageNum: number;
  pageSize: number;
  type?: { [OpTypes.eq]: string };
  status?: { [OpTypes.eq]: string };
  create_by?: string;
  create_By?: string;
  department_code?: string;
}

export interface IGenTask {
  type?: string;
  formData?:
    | ILongTextGenFormData
    | IImageGenFormData
    | IQuestionGenFormData
    | IVoiceGenFormData
    | ISearchTaskFormData
    | IChatTaskFormData;
  status?: string;
}

export interface IGenTaskSer {
  id?: StringDataType;
  type?: string;
  form_data?: string;
  status?: string;
  del_flag?: string;
  create_by?: string;
  update_by?: string;
  department_code?: string;
  created_at?: string;
  updated_at?: string;
}
