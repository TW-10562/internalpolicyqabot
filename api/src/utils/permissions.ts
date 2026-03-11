/**
 * 権限リスト
 */
const PERMISSIONS = {
  CREATE: 'C',
  READ: 'R',
  UPDATE: 'U',
  DELETE: 'D',

  READ_ROLE: 'R|role',
  CREATE_ROLE: 'C|role',
  UPDATE_ROLE: 'U|role',
  DELETE_ROLE: 'D|role',

  READ_USER: 'R|user',
  CREATE_USER: 'C|user',
  UPDATE_USER: 'U|user',
  DELETE_USER: 'D|user',

  READ_MENU: 'R|menu',
  CREATE_MENU: 'C|menu',
  UPDATE_MENU: 'U|menu',
  DELETE_MENU: 'D|menu',

};

export default PERMISSIONS;
