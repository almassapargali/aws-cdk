const baseConfig = require('../../../tools/cdk-build-tools/config/jest.config');
module.exports = {
  ...baseConfig,
  coverageThreshold: {
    global: {
      statements: 70,
      branches: 50,
    }
  }
};