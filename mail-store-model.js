import Sequelize from 'sequelize';
export default function(password, options = {}) {

  const sequelize = new Sequelize(
    options.dbName || 'mailstore',
    options.dbUser || 'mailstore',
    password, {
      dialect: 'postgres',
      host: 'localhost',
      port: 5432,
      schema: options.schema || 'main',
      ...options
    }
  );
  const model = {
    sequelize,
    Sequelize
  };
  model.TestEmail = sequelize.define('testEmail', {
    id: {
      type: Sequelize.BIGINT,
      primaryKey: true,
      allowNull: false,
      autoIncrement: true
    },
    address: {
      type: Sequelize.STRING(128),
      allowNull: false
    },
    data: {
      type: Sequelize.JSONB,
      allowNull: true
    },
    ['created_at']: {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.NOW
    },
    group: {
      type: Sequelize.STRING(32),
      allowNull: true
    }
  }, {
    timestamps: false,
    tableName: 'test_emails',
    indexes: [{
      name: 'email_address_index',
      unique: false,
      fields: ['address', 'created_at']
    }, {
      name: 'email_group_index',
      unique: false,
      fields: ['group', 'address', 'created_at']
    }, {
      name: 'eamail_created_at_index',
      unique: false,
      fields: ['created_at']
    }]
  });
  return model;
}

