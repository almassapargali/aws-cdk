import { Match, Template } from '@aws-cdk/assertions';
import * as iam from '@aws-cdk/aws-iam';
import * as cdk from '@aws-cdk/core';
import { LogRetention, RetentionDays } from '../lib';

/* eslint-disable quote-props */

describe('log retention', () => {
  test('log retention construct', () => {
    // GIVEN
    const stack = new cdk.Stack();

    // WHEN
    new LogRetention(stack, 'MyLambda', {
      logGroupName: 'group',
      retention: RetentionDays.ONE_MONTH,
    });

    // THEN
    Template.fromStack(stack).hasResourceProperties('AWS::IAM::Policy', {
      'PolicyDocument': {
        'Statement': [
          {
            'Action': [
              'logs:PutRetentionPolicy',
              'logs:DeleteRetentionPolicy',
            ],
            'Effect': 'Allow',
            'Resource': '*',
          },
        ],
        'Version': '2012-10-17',
      },
      'PolicyName': 'LogRetentionaae0aa3c5b4d4f87b02d85b201efdd8aServiceRoleDefaultPolicyADDA7DEB',
      'Roles': [
        {
          'Ref': 'LogRetentionaae0aa3c5b4d4f87b02d85b201efdd8aServiceRole9741ECFB',
        },
      ],
    });

    Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.handler',
      Runtime: 'nodejs14.x',
    });

    Template.fromStack(stack).hasResourceProperties('Custom::LogRetention', {
      'ServiceToken': {
        'Fn::GetAtt': [
          'LogRetentionaae0aa3c5b4d4f87b02d85b201efdd8aFD4BFC8A',
          'Arn',
        ],
      },
      'LogGroupName': 'group',
      'RetentionInDays': 30,
    });


  });

  test('with imported role', () => {
    // GIVEN
    const stack = new cdk.Stack();
    const role = iam.Role.fromRoleArn(stack, 'Role', 'arn:aws:iam::123456789012:role/CoolRole');

    // WHEN
    new LogRetention(stack, 'MyLambda', {
      logGroupName: 'group',
      retention: RetentionDays.ONE_MONTH,
      role,
    });

    // THEN
    Template.fromStack(stack).hasResourceProperties('AWS::IAM::Policy', {
      'PolicyDocument': {
        'Statement': [
          {
            'Action': [
              'logs:PutRetentionPolicy',
              'logs:DeleteRetentionPolicy',
            ],
            'Effect': 'Allow',
            'Resource': '*',
          },
        ],
        'Version': '2012-10-17',
      },
      'PolicyName': 'RolePolicy72E7D967',
      'Roles': [
        'CoolRole',
      ],
    });

    Template.fromStack(stack).resourceCountIs('AWS::IAM::Role', 0);


  });

  test('with RetentionPeriod set to Infinity', () => {
    const stack = new cdk.Stack();

    new LogRetention(stack, 'MyLambda', {
      logGroupName: 'group',
      retention: RetentionDays.INFINITE,
    });

    Template.fromStack(stack).hasResourceProperties('Custom::LogRetention', {
      RetentionInDays: Match.absentProperty(),
    });


  });

  test('with LogGroupRegion specified', () => {
    const stack = new cdk.Stack();
    new LogRetention(stack, 'MyLambda', {
      logGroupName: 'group',
      logGroupRegion: 'us-east-1',
      retention: RetentionDays.INFINITE,
    });

    Template.fromStack(stack).hasResourceProperties('Custom::LogRetention', {
      LogGroupRegion: 'us-east-1',
    });


  });

  test('log group ARN is well formed and conforms', () => {
    const stack = new cdk.Stack();
    const group = new LogRetention(stack, 'MyLambda', {
      logGroupName: 'group',
      retention: RetentionDays.ONE_MONTH,
    });

    const logGroupArn = group.logGroupArn;
    expect(logGroupArn.indexOf('logs')).toBeGreaterThan(-1);
    expect(logGroupArn.indexOf('log-group')).toBeGreaterThan(-1);
    expect(logGroupArn.endsWith(':*')).toEqual(true);

  });

  test('log group ARN is well formed and conforms when region is specified', () => {
    const stack = new cdk.Stack();
    const group = new LogRetention(stack, 'MyLambda', {
      logGroupName: 'group',
      logGroupRegion: 'us-west-2',
      retention: RetentionDays.ONE_MONTH,
    });

    const logGroupArn = group.logGroupArn;
    expect(logGroupArn.indexOf('us-west-2')).toBeGreaterThan(-1);
    expect(logGroupArn.indexOf('logs')).toBeGreaterThan(-1);
    expect(logGroupArn.indexOf('log-group')).toBeGreaterThan(-1);
    expect(logGroupArn.endsWith(':*')).toEqual(true);

  });
});
