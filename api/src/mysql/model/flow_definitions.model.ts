import { DataTypes } from 'sequelize';
import seq from '@/mysql/db/seq.db';

const FlowDefinitions = seq.define(
    'flow_definitions',
    {
        id: {
            type: DataTypes.STRING(21),
            primaryKey: true,
            allowNull: false,
        },
        name: {
            type: DataTypes.STRING(100),
            allowNull: false,
        },
        description: {
            type: DataTypes.TEXT,
        },
        json_schema: {
            type: DataTypes.TEXT
        },
        create_by: {
            type: DataTypes.CHAR(64),
            defaultValue: null,
            comment: '',
        },
        created_at: {
            type: DataTypes.DATE,
            defaultValue: null,
            comment: '',
        },
        update_by: {
            type: DataTypes.CHAR(64),
            defaultValue: null,
            comment: '',
        },
        updated_at: {
            type: DataTypes.DATE,
            defaultValue: null,
            comment: '',
        },
    },
    {
        tableName: 'flow_definitions',
        freezeTableName: true,
        comment: '',
    },
)

export default FlowDefinitions;