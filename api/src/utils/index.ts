import bcrypt from 'bcryptjs';
import fs from 'fs';
import { FILE_UPLOAD_DIR } from '@/config/uploadPath';

export const removeSpecifyFile = (filename: string): boolean => {
  if (fs.existsSync(FILE_UPLOAD_DIR)) {
    fs.unlinkSync(`${FILE_UPLOAD_DIR}/${filename}`);
  } else {
    return false;
  }
  return true;
};

export const removeFolder = (folderPath: string) => {
  const files = fs.readdirSync(folderPath);

  for (const item of files) {
    const stats = fs.statSync(`${folderPath}/${item}`);
    if (stats.isDirectory()) {
      removeFolder(`${folderPath}/${item}`);
    } else {
      fs.unlinkSync(`${folderPath}/${item}`);
    }
  }
  fs.rmdirSync(folderPath);
};

export const delFiles = (folderPath: string) => {
  const files = fs.readdirSync(folderPath);

  for (const item of files) {
    fs.unlinkSync(`${folderPath}/${item}`);
  }
};

export const formatHumpLineTransfer = (data, type = 'hump'): Array<any> => {
  const newData = Object.prototype.toString.call(data) === '[object Object]' ? [JSON.parse(JSON.stringify(data))] : JSON.parse(JSON.stringify(data));

  function toggleFn(list) {
    list.forEach((item) => {
      for (const key in item) {
        if (Object.prototype.toString.call(item[key]) === '[object Object]') {
          toggleFn([item[key]]);
        } else if (Object.prototype.toString.call(item[key]) === '[object Array]') {
          toggleFn(item[key]);
        } else if (type === 'hump') {
          const keyArr = key.split('_');
          let str = '';
          if (keyArr.length > 1) {
            keyArr.forEach((itemKey, index) => {
              if (itemKey) {
                if (index) {
                  const arr = itemKey.split('');
                  arr[0] = arr[0].toUpperCase();
                  str += arr.join('');
                } else {
                  str += itemKey;
                }
              }
              if (!itemKey) {
                keyArr.splice(0, 1);
              }
            });
            const newValue = item[key];
            // eslint-disable-next-line no-param-reassign
            delete item[key];
            // eslint-disable-next-line no-param-reassign
            item[str] = newValue;
          }
        } else if (type === 'line') {
          const regexp = /^[A-Z]+$/;
          const newKey = key.split('');
          const newValue = item[key];
          newKey.forEach((item2, index2) => {
            if (regexp.test(item2)) {
              newKey[index2] = `_${item2.toLowerCase()}`;
            }
          });
          // eslint-disable-next-line no-param-reassign
          delete item[key];
          // eslint-disable-next-line no-param-reassign
          item[newKey.join('')] = newValue;
        }
      }
    });
  }
  toggleFn(newData);
  if (Object.prototype.toString.call(data) === '[object Object]') {
    let obj = null;
    newData.forEach((item) => {
      obj = item;
    });
    return obj;
  }
  return newData;
};

export const flatten = (obj: any) => {
  const result = {};

  const process = (key: string, value: string | any[]) => {
    if (Object.prototype.toString.call(value) === '[object Object]') {
      const objArr = Object.keys(value);
      objArr.forEach((item) => {
        process(key ? `${key}.${item}` : `${item}`, value[item]);
      });
      if (objArr.length === 0 && key) {
        result[key] = {};
      }
    } else if (Array.isArray(value)) {
      // eslint-disable-next-line no-plusplus
      for (let i = 0; i < value.length; i++) {
        process(`${key}[${i}]`, value[i]);
      }
      if (value.length === 0) {
        result[key] = [];
      }
    } else if (key) {
      result[key] = value;
    }
  };
  process('', obj);
  return result;
};

export const underlineToCamel = (str: string) => str.replace(/_(\w)/g, (match, p1) => p1.toUpperCase()).replace(/^\w/, (match) => match.toUpperCase());

export const underline = (str: string) => str.replace(/_(\w)/g, (match, p1) => p1.toUpperCase());

export const createHash = (hashLength = 30) => Array.from(Array(Number(hashLength)), () => Math.floor(Math.random() * 36).toString(36)).join('');

export const pwdHash = (newPwd: string) => {
  const salt = bcrypt.genSaltSync(10);
  return bcrypt.hashSync(newPwd, salt);
};
