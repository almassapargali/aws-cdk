import { Match, Template } from '@aws-cdk/assertions';
import * as cdk from '@aws-cdk/core';
import * as codepipeline from '../lib';
import { FakeBuildAction } from './fake-build-action';
import { FakeSourceAction } from './fake-source-action';

/* eslint-disable quote-props */

describe('artifacts', () => {
  describe('Artifacts in CodePipeline', () => {
    test('cannot be created with an empty name', () => {
      expect(() => new codepipeline.Artifact('')).toThrow(/Artifact name must match regular expression/);


    });

    test('without a name, when used as an input without being used as an output first - should fail validation', () => {
      const stack = new cdk.Stack();
      const sourceOutput = new codepipeline.Artifact();
      const pipeline = new codepipeline.Pipeline(stack, 'Pipeline', {
        stages: [
          {
            stageName: 'Source',
            actions: [
              new FakeSourceAction({
                actionName: 'Source',
                output: sourceOutput,
              }),
            ],
          },
          {
            stageName: 'Build',
            actions: [
              new FakeBuildAction({
                actionName: 'Build',
                input: new codepipeline.Artifact(),
              }),
            ],
          },
        ],
      });

      const errors = validate(stack);

      expect(errors.length).toEqual(1);
      const error = errors[0];
      expect(error.source).toEqual(pipeline);
      expect(error.message).toEqual("Action 'Build' is using an unnamed input Artifact, which is not being produced in this pipeline");


    });

    test('with a name, when used as an input without being used as an output first - should fail validation', () => {
      const stack = new cdk.Stack();
      const sourceOutput = new codepipeline.Artifact();
      const pipeline = new codepipeline.Pipeline(stack, 'Pipeline', {
        stages: [
          {
            stageName: 'Source',
            actions: [
              new FakeSourceAction({
                actionName: 'Source',
                output: sourceOutput,
              }),
            ],
          },
          {
            stageName: 'Build',
            actions: [
              new FakeBuildAction({
                actionName: 'Build',
                input: new codepipeline.Artifact('named'),
              }),
            ],
          },
        ],
      });

      const errors = validate(stack);

      expect(errors.length).toEqual(1);
      const error = errors[0];
      expect(error.source).toEqual(pipeline);
      expect(error.message).toEqual("Action 'Build' is using input Artifact 'named', which is not being produced in this pipeline");


    });

    test('without a name, when used as an output multiple times - should fail validation', () => {
      const stack = new cdk.Stack();
      const sourceOutput = new codepipeline.Artifact();
      const pipeline = new codepipeline.Pipeline(stack, 'Pipeline', {
        stages: [
          {
            stageName: 'Source',
            actions: [
              new FakeSourceAction({
                actionName: 'Source',
                output: sourceOutput,
              }),
            ],
          },
          {
            stageName: 'Build',
            actions: [
              new FakeBuildAction({
                actionName: 'Build',
                input: sourceOutput,
                output: sourceOutput,
              }),
            ],
          },
        ],
      });

      const errors = validate(stack);

      expect(errors.length).toEqual(1);
      const error = errors[0];
      expect(error.source).toEqual(pipeline);
      expect(error.message).toEqual("Both Actions 'Source' and 'Build' are producting Artifact 'Artifact_Source_Source'. Every artifact can only be produced once.");


    });

    test("an Action's output can be used as input for an Action in the same Stage with a higher runOrder", () => {
      const stack = new cdk.Stack();

      const sourceOutput1 = new codepipeline.Artifact('sourceOutput1');
      const buildOutput1 = new codepipeline.Artifact('buildOutput1');
      const sourceOutput2 = new codepipeline.Artifact('sourceOutput2');

      new codepipeline.Pipeline(stack, 'Pipeline', {
        stages: [
          {
            stageName: 'Source',
            actions: [
              new FakeSourceAction({
                actionName: 'source1',
                output: sourceOutput1,
              }),
              new FakeSourceAction({
                actionName: 'source2',
                output: sourceOutput2,
              }),
            ],
          },
          {
            stageName: 'Build',
            actions: [
              new FakeBuildAction({
                actionName: 'build1',
                input: sourceOutput1,
                output: buildOutput1,
              }),
              new FakeBuildAction({
                actionName: 'build2',
                input: sourceOutput2,
                extraInputs: [buildOutput1],
                output: new codepipeline.Artifact('buildOutput2'),
                runOrder: 2,
              }),
            ],
          },
        ],
      });

      Template.fromStack(stack).resourceCountIs('AWS::CodePipeline::Pipeline', 1);


    });

    test('violation of runOrder constraints is detected and reported', () => {
      const stack = new cdk.Stack();

      const sourceOutput1 = new codepipeline.Artifact('sourceOutput1');
      const buildOutput1 = new codepipeline.Artifact('buildOutput1');
      const sourceOutput2 = new codepipeline.Artifact('sourceOutput2');

      const pipeline = new codepipeline.Pipeline(stack, 'Pipeline', {
        stages: [
          {
            stageName: 'Source',
            actions: [
              new FakeSourceAction({
                actionName: 'source1',
                output: sourceOutput1,
              }),
              new FakeSourceAction({
                actionName: 'source2',
                output: sourceOutput2,
              }),
            ],
          },
          {
            stageName: 'Build',
            actions: [
              new FakeBuildAction({
                actionName: 'build1',
                input: sourceOutput1,
                output: buildOutput1,
                runOrder: 3,
              }),
              new FakeBuildAction({
                actionName: 'build2',
                input: sourceOutput2,
                extraInputs: [buildOutput1],
                output: new codepipeline.Artifact('buildOutput2'),
                runOrder: 2,
              }),
            ],
          },
        ],
      });

      const errors = validate(stack);

      expect(errors.length).toEqual(1);
      const error = errors[0];
      expect(error.source).toEqual(pipeline);
      expect(error.message).toEqual("Stage 2 Action 2 ('Build'/'build2') is consuming input Artifact 'buildOutput1' before it is being produced at Stage 2 Action 3 ('Build'/'build1')");


    });

    test('without a name, sanitize the auto stage-action derived name', () => {
      const stack = new cdk.Stack();

      const sourceOutput = new codepipeline.Artifact();
      new codepipeline.Pipeline(stack, 'Pipeline', {
        stages: [
          {
            stageName: 'Source.@', // @ and . are not allowed in Artifact names!
            actions: [
              new FakeSourceAction({
                actionName: 'source1',
                output: sourceOutput,
              }),
            ],
          },
          {
            stageName: 'Build',
            actions: [
              new FakeBuildAction({
                actionName: 'build1',
                input: sourceOutput,
              }),
            ],
          },
        ],
      });

      Template.fromStack(stack).hasResourceProperties('AWS::CodePipeline::Pipeline', {
        'Stages': [
          {
            'Name': 'Source.@',
            'Actions': [
              Match.objectLike({
                'Name': 'source1',
                'OutputArtifacts': [
                  { 'Name': 'Artifact_Source_source1' },
                ],
              }),
            ],
          },
          {
            'Name': 'Build',
            'Actions': [
              Match.objectLike({
                'Name': 'build1',
                'InputArtifacts': [
                  { 'Name': 'Artifact_Source_source1' },
                ],
              }),
            ],
          },
        ],
      });


    });
  });
});

/* eslint-disable cdk/no-core-construct */
function validate(construct: cdk.IConstruct): cdk.ValidationError[] {
  cdk.ConstructNode.prepare(construct.node);
  return cdk.ConstructNode.validate(construct.node);
}
/* eslint-enable cdk/no-core-construct */
