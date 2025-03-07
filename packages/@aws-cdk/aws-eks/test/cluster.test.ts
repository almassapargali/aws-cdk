import * as fs from 'fs';
import * as path from 'path';
import '@aws-cdk/assert-internal/jest';
import { SynthUtils } from '@aws-cdk/assert-internal';
import * as asg from '@aws-cdk/aws-autoscaling';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as iam from '@aws-cdk/aws-iam';
import * as kms from '@aws-cdk/aws-kms';
import * as lambda from '@aws-cdk/aws-lambda';
import * as cdk from '@aws-cdk/core';
import * as cdk8s from 'cdk8s';
import * as constructs from 'constructs';
import * as YAML from 'yaml';
import * as eks from '../lib';
import { BottleRocketImage } from '../lib/private/bottlerocket';
import { testFixture, testFixtureNoVpc } from './util';

/* eslint-disable max-len */

const CLUSTER_VERSION = eks.KubernetesVersion.V1_21;

describe('cluster', () => {

  test('can specify custom environment to cluster resource handler', () => {

    const { stack } = testFixture();

    new eks.Cluster(stack, 'Cluster', {
      version: CLUSTER_VERSION,
      clusterHandlerEnvironment: {
        foo: 'bar',
      },
    });

    const nested = stack.node.tryFindChild('@aws-cdk/aws-eks.ClusterResourceProvider') as cdk.NestedStack;

    const template = SynthUtils.toCloudFormation(nested);
    expect(template.Resources.OnEventHandler42BEBAE0.Properties.Environment).toEqual({ Variables: { foo: 'bar' } });
  });

  test('throws when trying to place cluster handlers in a vpc with no private subnets', () => {
    const { stack } = testFixture();

    const vpc = new ec2.Vpc(stack, 'Vpc');

    expect(() => {
      new eks.Cluster(stack, 'Cluster', {
        version: CLUSTER_VERSION,
        placeClusterHandlerInVpc: true,
        vpc: vpc,
        vpcSubnets: [{ subnetType: ec2.SubnetType.PUBLIC }],
      });
    }).toThrow(/Cannot place cluster handler in the VPC since no private subnets could be selected/);


  });

  describe('imported Vpc from unparseable list tokens', () => {
    let stack: cdk.Stack;
    let vpc: ec2.IVpc;

    beforeEach(() => {
      stack = new cdk.Stack();
      const vpcId = cdk.Fn.importValue('myVpcId');
      const availabilityZones = cdk.Fn.split(',', cdk.Fn.importValue('myAvailabilityZones'));
      const publicSubnetIds = cdk.Fn.split(',', cdk.Fn.importValue('myPublicSubnetIds'));
      const privateSubnetIds = cdk.Fn.split(',', cdk.Fn.importValue('myPrivateSubnetIds'));
      const isolatedSubnetIds = cdk.Fn.split(',', cdk.Fn.importValue('myIsolatedSubnetIds'));

      vpc = ec2.Vpc.fromVpcAttributes(stack, 'importedVpc', {
        vpcId,
        availabilityZones,
        publicSubnetIds,
        privateSubnetIds,
        isolatedSubnetIds,
      });


    });

    test('throws if selecting more than one subnet group', () => {
      expect(() => new eks.Cluster(stack, 'Cluster', {
        vpc: vpc,
        vpcSubnets: [{ subnetType: ec2.SubnetType.PUBLIC }, { subnetType: ec2.SubnetType.PRIVATE }],
        defaultCapacity: 0,
        version: eks.KubernetesVersion.V1_21,
      })).toThrow(/cannot select multiple subnet groups/);


    });

    test('synthesis works if only one subnet group is selected', () => {
      // WHEN
      new eks.Cluster(stack, 'Cluster', {
        vpc: vpc,
        vpcSubnets: [{ subnetType: ec2.SubnetType.PUBLIC }],
        defaultCapacity: 0,
        version: eks.KubernetesVersion.V1_21,
      });

      // THEN
      expect(stack).toHaveResourceLike('Custom::AWSCDK-EKS-Cluster', {
        Config: {
          resourcesVpcConfig: {
            subnetIds: {
              'Fn::Split': [
                ',',
                { 'Fn::ImportValue': 'myPublicSubnetIds' },
              ],
            },
          },
        },
      });


    });
  });

  test('throws when accessing cluster security group for imported cluster without cluster security group id', () => {

    const { stack } = testFixture();

    const cluster = eks.Cluster.fromClusterAttributes(stack, 'Cluster', {
      clusterName: 'cluster',
    });

    expect(() => cluster.clusterSecurityGroup).toThrow(/"clusterSecurityGroup" is not defined for this imported cluster/);


  });

  test('can place cluster handlers in the cluster vpc', () => {

    const { stack } = testFixture();

    new eks.Cluster(stack, 'Cluster', {
      version: CLUSTER_VERSION,
      placeClusterHandlerInVpc: true,
    });

    const nested = stack.node.tryFindChild('@aws-cdk/aws-eks.ClusterResourceProvider') as cdk.NestedStack;
    const template = SynthUtils.toCloudFormation(nested);

    function assertFunctionPlacedInVpc(id: string) {
      expect(template.Resources[id].Properties.VpcConfig.SubnetIds).toEqual([
        { Ref: 'referencetoStackClusterDefaultVpcPrivateSubnet1SubnetA64D1BF0Ref' },
        { Ref: 'referencetoStackClusterDefaultVpcPrivateSubnet2Subnet32D85AB8Ref' },
      ]);
    }

    assertFunctionPlacedInVpc('OnEventHandler42BEBAE0');
    assertFunctionPlacedInVpc('IsCompleteHandler7073F4DA');
    assertFunctionPlacedInVpc('ProviderframeworkonEvent83C1D0A7');
    assertFunctionPlacedInVpc('ProviderframeworkisComplete26D7B0CB');
    assertFunctionPlacedInVpc('ProviderframeworkonTimeout0B47CA38');


  });

  test('can access cluster security group for imported cluster with cluster security group id', () => {

    const { stack } = testFixture();

    const clusterSgId = 'cluster-sg-id';

    const cluster = eks.Cluster.fromClusterAttributes(stack, 'Cluster', {
      clusterName: 'cluster',
      clusterSecurityGroupId: clusterSgId,
    });

    const clusterSg = cluster.clusterSecurityGroup;

    expect(clusterSg.securityGroupId).toEqual(clusterSgId);

  });

  test('cluster security group is attached when adding self-managed nodes', () => {

    // GIVEN
    const { stack, vpc } = testFixture();
    const cluster = new eks.Cluster(stack, 'Cluster', {
      vpc,
      defaultCapacity: 0,
      version: CLUSTER_VERSION,
      prune: false,
    });

    // WHEN
    cluster.addAutoScalingGroupCapacity('self-managed', {
      instanceType: new ec2.InstanceType('t2.medium'),
    });

    const template = SynthUtils.toCloudFormation(stack);
    expect(template.Resources.ClusterselfmanagedLaunchConfigA5B57EF6.Properties.SecurityGroups).toEqual([
      { 'Fn::GetAtt': ['ClusterselfmanagedInstanceSecurityGroup64468C3A', 'GroupId'] },
      { 'Fn::GetAtt': ['Cluster9EE0221C', 'ClusterSecurityGroupId'] },
    ]);


  });

  test('security group of self-managed asg is not tagged with owned', () => {

    // GIVEN
    const { stack, vpc } = testFixture();
    const cluster = new eks.Cluster(stack, 'Cluster', {
      vpc,
      version: CLUSTER_VERSION,
    });

    // WHEN
    cluster.addAutoScalingGroupCapacity('self-managed', {
      instanceType: new ec2.InstanceType('t2.medium'),
    });

    const template = SynthUtils.toCloudFormation(stack);
    // make sure the "kubernetes.io/cluster/<CLUSTER_NAME>: owned" tag isn't here.
    expect(template.Resources.ClusterselfmanagedInstanceSecurityGroup64468C3A.Properties.Tags).toEqual([
      { Key: 'Name', Value: 'Stack/Cluster/self-managed' },
    ]);


  });

  test('cluster security group is attached when connecting self-managed nodes', () => {

    // GIVEN
    const { stack, vpc } = testFixture();
    const cluster = new eks.Cluster(stack, 'Cluster', {
      vpc,
      defaultCapacity: 0,
      version: CLUSTER_VERSION,
      prune: false,
    });

    const selfManaged = new asg.AutoScalingGroup(stack, 'self-managed', {
      instanceType: new ec2.InstanceType('t2.medium'),
      vpc: vpc,
      machineImage: new ec2.AmazonLinuxImage(),
    });

    // WHEN
    cluster.connectAutoScalingGroupCapacity(selfManaged, {});

    const template = SynthUtils.toCloudFormation(stack);
    expect(template.Resources.selfmanagedLaunchConfigD41289EB.Properties.SecurityGroups).toEqual([
      { 'Fn::GetAtt': ['selfmanagedInstanceSecurityGroupEA6D80C9', 'GroupId'] },
      { 'Fn::GetAtt': ['Cluster9EE0221C', 'ClusterSecurityGroupId'] },
    ]);


  });

  test('spot interrupt handler is not added if spotInterruptHandler is false when connecting self-managed nodes', () => {

    // GIVEN
    const { stack, vpc } = testFixture();
    const cluster = new eks.Cluster(stack, 'Cluster', {
      vpc,
      defaultCapacity: 0,
      version: CLUSTER_VERSION,
      prune: false,
    });

    const selfManaged = new asg.AutoScalingGroup(stack, 'self-managed', {
      instanceType: new ec2.InstanceType('t2.medium'),
      vpc: vpc,
      machineImage: new ec2.AmazonLinuxImage(),
      spotPrice: '0.1',
    });

    // WHEN
    cluster.connectAutoScalingGroupCapacity(selfManaged, { spotInterruptHandler: false });

    expect(cluster.node.findAll().filter(c => c.node.id === 'chart-spot-interrupt-handler').length).toEqual(0);

  });

  test('throws when a non cdk8s chart construct is added as cdk8s chart', () => {

    const { stack } = testFixture();

    const cluster = new eks.Cluster(stack, 'Cluster', {
      version: CLUSTER_VERSION,
      prune: false,
    });

    // create a plain construct, not a cdk8s chart
    const someConstruct = new constructs.Construct(stack, 'SomeConstruct');

    expect(() => cluster.addCdk8sChart('chart', someConstruct)).toThrow(/Invalid cdk8s chart. Must contain a \'toJson\' method, but found undefined/);


  });

  test('throws when a core construct is added as cdk8s chart', () => {

    const { stack } = testFixture();

    const cluster = new eks.Cluster(stack, 'Cluster', {
      version: CLUSTER_VERSION,
      prune: false,
    });

    // create a plain construct, not a cdk8s chart
    const someConstruct = new cdk.Construct(stack, 'SomeConstruct');

    expect(() => cluster.addCdk8sChart('chart', someConstruct)).toThrow(/Invalid cdk8s chart. Must contain a \'toJson\' method, but found undefined/);


  });

  test('cdk8s chart can be added to cluster', () => {

    const { stack } = testFixture();

    const cluster = new eks.Cluster(stack, 'Cluster', {
      version: CLUSTER_VERSION,
      prune: false,
    });

    const app = new cdk8s.App();
    const chart = new cdk8s.Chart(app, 'Chart');

    new cdk8s.ApiObject(chart, 'FakePod', {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: 'fake-pod',
        labels: {
          // adding aws-cdk token to cdk8s chart
          clusterName: cluster.clusterName,
        },
      },
    });

    cluster.addCdk8sChart('cdk8s-chart', chart);

    expect(stack).toHaveResourceLike('Custom::AWSCDK-EKS-KubernetesResource', {
      Manifest: {
        'Fn::Join': [
          '',
          [
            '[{"apiVersion":"v1","kind":"Pod","metadata":{"labels":{"clusterName":"',
            {
              Ref: 'Cluster9EE0221C',
            },
            '"},"name":"fake-pod"}}]',
          ],
        ],
      },
    });


  });

  test('cluster connections include both control plane and cluster security group', () => {

    const { stack } = testFixture();

    const cluster = new eks.Cluster(stack, 'Cluster', {
      version: CLUSTER_VERSION,
      prune: false,
    });

    expect(cluster.connections.securityGroups.map(sg => stack.resolve(sg.securityGroupId))).toEqual([
      { 'Fn::GetAtt': ['Cluster9EE0221C', 'ClusterSecurityGroupId'] },
      { 'Fn::GetAtt': ['ClusterControlPlaneSecurityGroupD274242C', 'GroupId'] },
    ]);


  });

  test('can declare a security group from a different stack', () => {

    class ClusterStack extends cdk.Stack {
      public eksCluster: eks.Cluster;

      constructor(scope: constructs.Construct, id: string, props: { sg: ec2.ISecurityGroup, vpc: ec2.IVpc }) {
        super(scope, id);
        this.eksCluster = new eks.Cluster(this, 'Cluster', {
          version: CLUSTER_VERSION,
          prune: false,
          securityGroup: props.sg,
          vpc: props.vpc,
        });
      }
    }

    class NetworkStack extends cdk.Stack {

      public readonly securityGroup: ec2.ISecurityGroup;
      public readonly vpc: ec2.IVpc;

      constructor(scope: constructs.Construct, id: string) {
        super(scope, id);
        this.vpc = new ec2.Vpc(this, 'Vpc');
        this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', { vpc: this.vpc });
      }

    }

    const { app } = testFixture();
    const networkStack = new NetworkStack(app, 'NetworkStack');
    new ClusterStack(app, 'ClusterStack', { sg: networkStack.securityGroup, vpc: networkStack.vpc });

    // make sure we can synth (no circular dependencies between the stacks)
    app.synth();


  });

  test('can declare a manifest with a token from a different stack than the cluster that depends on the cluster stack', () => {

    class ClusterStack extends cdk.Stack {
      public eksCluster: eks.Cluster;

      constructor(scope: constructs.Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);
        this.eksCluster = new eks.Cluster(this, 'Cluster', {
          version: CLUSTER_VERSION,
          prune: false,
        });
      }
    }

    class ManifestStack extends cdk.Stack {
      constructor(scope: constructs.Construct, id: string, props: cdk.StackProps & { cluster: eks.Cluster }) {
        super(scope, id, props);

        // this role creates a dependency between this stack and the cluster stack
        const role = new iam.Role(this, 'CrossRole', {
          assumedBy: new iam.ServicePrincipal('sqs.amazonaws.com'),
          roleName: props.cluster.clusterArn,
        });

        // make sure this manifest doesn't create a dependency between the cluster stack
        // and this stack
        new eks.KubernetesManifest(this, 'cross-stack', {
          manifest: [{
            kind: 'ConfigMap',
            apiVersion: 'v1',
            metadata: {
              name: 'config-map',
            },
            data: {
              foo: role.roleArn,
            },
          }],
          cluster: props.cluster,
        });
      }
    }

    const { app } = testFixture();
    const clusterStack = new ClusterStack(app, 'ClusterStack');
    new ManifestStack(app, 'ManifestStack', { cluster: clusterStack.eksCluster });

    // make sure we can synth (no circular dependencies between the stacks)
    app.synth();


  });

  test('can declare a chart with a token from a different stack than the cluster that depends on the cluster stack', () => {

    class ClusterStack extends cdk.Stack {
      public eksCluster: eks.Cluster;

      constructor(scope: constructs.Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);
        this.eksCluster = new eks.Cluster(this, 'Cluster', {
          version: CLUSTER_VERSION,
          prune: false,
        });
      }
    }

    class ChartStack extends cdk.Stack {
      constructor(scope: constructs.Construct, id: string, props: cdk.StackProps & { cluster: eks.Cluster }) {
        super(scope, id, props);

        // this role creates a dependency between this stack and the cluster stack
        const role = new iam.Role(this, 'CrossRole', {
          assumedBy: new iam.ServicePrincipal('sqs.amazonaws.com'),
          roleName: props.cluster.clusterArn,
        });

        // make sure this chart doesn't create a dependency between the cluster stack
        // and this stack
        new eks.HelmChart(this, 'cross-stack', {
          chart: role.roleArn,
          cluster: props.cluster,
        });
      }
    }

    const { app } = testFixture();
    const clusterStack = new ClusterStack(app, 'ClusterStack');
    new ChartStack(app, 'ChartStack', { cluster: clusterStack.eksCluster });

    // make sure we can synth (no circular dependencies between the stacks)
    app.synth();


  });

  test('can declare a HelmChart in a different stack than the cluster', () => {

    class ClusterStack extends cdk.Stack {
      public eksCluster: eks.Cluster;

      constructor(scope: constructs.Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);
        this.eksCluster = new eks.Cluster(this, 'Cluster', {
          version: CLUSTER_VERSION,
          prune: false,
        });
      }
    }

    class ChartStack extends cdk.Stack {
      constructor(scope: constructs.Construct, id: string, props: cdk.StackProps & { cluster: eks.Cluster }) {
        super(scope, id, props);

        const resource = new cdk.CfnResource(this, 'resource', { type: 'MyType' });
        new eks.HelmChart(this, `chart-${id}`, { cluster: props.cluster, chart: resource.ref });

      }
    }

    const { app } = testFixture();
    const clusterStack = new ClusterStack(app, 'ClusterStack');
    new ChartStack(app, 'ChartStack', { cluster: clusterStack.eksCluster });

    // make sure we can synth (no circular dependencies between the stacks)
    app.synth();


  });

  test('throws when declaring an ASG role in a different stack than the cluster', () => {

    class ClusterStack extends cdk.Stack {
      public eksCluster: eks.Cluster;

      constructor(scope: constructs.Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);
        this.eksCluster = new eks.Cluster(this, 'Cluster', {
          version: CLUSTER_VERSION,
          prune: false,
        });
      }
    }

    class CapacityStack extends cdk.Stack {

      public group: asg.AutoScalingGroup;

      constructor(scope: constructs.Construct, id: string, props: cdk.StackProps & { cluster: eks.Cluster }) {
        super(scope, id, props);

        // the role is create in this stack implicitly by the ASG
        this.group = new asg.AutoScalingGroup(this, 'autoScaling', {
          instanceType: new ec2.InstanceType('t3.medium'),
          vpc: props.cluster.vpc,
          machineImage: new eks.EksOptimizedImage({
            kubernetesVersion: CLUSTER_VERSION.version,
            nodeType: eks.NodeType.STANDARD,
          }),
        });
      }
    }

    const { app } = testFixture();
    const clusterStack = new ClusterStack(app, 'ClusterStack');
    const capacityStack = new CapacityStack(app, 'CapacityStack', { cluster: clusterStack.eksCluster });

    expect(() => {
      clusterStack.eksCluster.connectAutoScalingGroupCapacity(capacityStack.group, {});
    }).toThrow(
      'CapacityStack/autoScaling/InstanceRole should be defined in the scope of the ClusterStack stack to prevent circular dependencies',
    );


  });

  test('can declare a ServiceAccount in a different stack than the cluster', () => {

    class ClusterStack extends cdk.Stack {
      public eksCluster: eks.Cluster;

      constructor(scope: constructs.Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);
        this.eksCluster = new eks.Cluster(this, 'EKSCluster', {
          version: CLUSTER_VERSION,
          prune: false,
        });
      }
    }

    class AppStack extends cdk.Stack {
      constructor(scope: constructs.Construct, id: string, props: cdk.StackProps & { cluster: eks.Cluster }) {
        super(scope, id, props);

        new eks.ServiceAccount(this, 'testAccount', { cluster: props.cluster, name: 'test-account', namespace: 'test' });
      }
    }

    const { app } = testFixture();
    const clusterStack = new ClusterStack(app, 'EKSCluster');
    new AppStack(app, 'KubeApp', { cluster: clusterStack.eksCluster });

    // make sure we can synth (no circular dependencies between the stacks)
    app.synth();


  });

  test('a default cluster spans all subnets', () => {
    // GIVEN
    const { stack, vpc } = testFixture();

    // WHEN
    new eks.Cluster(stack, 'Cluster', { vpc, defaultCapacity: 0, version: CLUSTER_VERSION, prune: false });

    // THEN
    expect(stack).toHaveResourceLike('Custom::AWSCDK-EKS-Cluster', {
      Config: {
        roleArn: { 'Fn::GetAtt': ['ClusterRoleFA261979', 'Arn'] },
        version: '1.21',
        resourcesVpcConfig: {
          securityGroupIds: [{ 'Fn::GetAtt': ['ClusterControlPlaneSecurityGroupD274242C', 'GroupId'] }],
          subnetIds: [
            { Ref: 'VPCPublicSubnet1SubnetB4246D30' },
            { Ref: 'VPCPublicSubnet2Subnet74179F39' },
            { Ref: 'VPCPrivateSubnet1Subnet8BCA10E0' },
            { Ref: 'VPCPrivateSubnet2SubnetCFCDAA7A' },
          ],
        },
      },
    });


  });

  test('if "vpc" is not specified, vpc with default configuration will be created', () => {
    // GIVEN
    const { stack } = testFixtureNoVpc();

    // WHEN
    new eks.Cluster(stack, 'cluster', { version: CLUSTER_VERSION, prune: false });

    // THEN
    expect(stack).toHaveResource('AWS::EC2::VPC');

  });

  describe('default capacity', () => {

    test('x2 m5.large by default', () => {
      // GIVEN
      const { stack } = testFixtureNoVpc();

      // WHEN
      const cluster = new eks.Cluster(stack, 'cluster', { version: CLUSTER_VERSION, prune: false });

      // THEN
      expect(cluster.defaultNodegroup).toBeDefined();
      expect(stack).toHaveResource('AWS::EKS::Nodegroup', {
        InstanceTypes: [
          'm5.large',
        ],
        ScalingConfig: {
          DesiredSize: 2,
          MaxSize: 2,
          MinSize: 2,
        },
      });

    });

    test('quantity and type can be customized', () => {
      // GIVEN
      const { stack } = testFixtureNoVpc();

      // WHEN
      const cluster = new eks.Cluster(stack, 'cluster', {
        defaultCapacity: 10,
        defaultCapacityInstance: new ec2.InstanceType('m2.xlarge'),
        version: CLUSTER_VERSION,
        prune: false,
      });

      // THEN
      expect(cluster.defaultNodegroup).toBeDefined();
      expect(stack).toHaveResource('AWS::EKS::Nodegroup', {
        ScalingConfig: {
          DesiredSize: 10,
          MaxSize: 10,
          MinSize: 10,
        },
      });
      // expect(stack).toHaveResource('AWS::AutoScaling::LaunchConfiguration', { InstanceType: 'm2.xlarge' }));

    });

    test('defaultCapacity=0 will not allocate at all', () => {
      // GIVEN
      const { stack } = testFixtureNoVpc();

      // WHEN
      const cluster = new eks.Cluster(stack, 'cluster', { defaultCapacity: 0, version: CLUSTER_VERSION, prune: false });

      // THEN
      expect(cluster.defaultCapacity).toBeUndefined();
      expect(stack).not.toHaveResource('AWS::AutoScaling::AutoScalingGroup');
      expect(stack).not.toHaveResource('AWS::AutoScaling::LaunchConfiguration');

    });
  });

  test('creating a cluster tags the private VPC subnets', () => {
    // GIVEN
    const { stack, vpc } = testFixture();

    // WHEN
    new eks.Cluster(stack, 'Cluster', { vpc, defaultCapacity: 0, version: CLUSTER_VERSION, prune: false });

    // THEN
    expect(stack).toHaveResource('AWS::EC2::Subnet', {
      Tags: [
        { Key: 'aws-cdk:subnet-name', Value: 'Private' },
        { Key: 'aws-cdk:subnet-type', Value: 'Private' },
        { Key: 'kubernetes.io/role/internal-elb', Value: '1' },
        { Key: 'Name', Value: 'Stack/VPC/PrivateSubnet1' },
      ],
    });


  });

  test('creating a cluster tags the public VPC subnets', () => {
    // GIVEN
    const { stack, vpc } = testFixture();

    // WHEN
    new eks.Cluster(stack, 'Cluster', { vpc, defaultCapacity: 0, version: CLUSTER_VERSION, prune: false });

    // THEN
    expect(stack).toHaveResource('AWS::EC2::Subnet', {
      MapPublicIpOnLaunch: true,
      Tags: [
        { Key: 'aws-cdk:subnet-name', Value: 'Public' },
        { Key: 'aws-cdk:subnet-type', Value: 'Public' },
        { Key: 'kubernetes.io/role/elb', Value: '1' },
        { Key: 'Name', Value: 'Stack/VPC/PublicSubnet1' },
      ],
    });


  });

  test('adding capacity creates an ASG without a rolling update policy', () => {
    // GIVEN
    const { stack, vpc } = testFixture();
    const cluster = new eks.Cluster(stack, 'Cluster', {
      vpc,
      defaultCapacity: 0,
      version: CLUSTER_VERSION,
      prune: false,
    });

    // WHEN
    cluster.addAutoScalingGroupCapacity('Default', {
      instanceType: new ec2.InstanceType('t2.medium'),
    });

    const template = SynthUtils.toCloudFormation(stack);
    expect(template.Resources.ClusterASG0E4BA723.UpdatePolicy).toEqual({ AutoScalingScheduledAction: { IgnoreUnmodifiedGroupSizeProperties: true } });

  });

  test('adding capacity creates an ASG with tags', () => {
    // GIVEN
    const { stack, vpc } = testFixture();
    const cluster = new eks.Cluster(stack, 'Cluster', {
      vpc,
      defaultCapacity: 0,
      version: CLUSTER_VERSION,
      prune: false,
    });

    // WHEN
    cluster.addAutoScalingGroupCapacity('Default', {
      instanceType: new ec2.InstanceType('t2.medium'),
    });

    // THEN
    expect(stack).toHaveResource('AWS::AutoScaling::AutoScalingGroup', {
      Tags: [
        {
          Key: { 'Fn::Join': ['', ['kubernetes.io/cluster/', { Ref: 'Cluster9EE0221C' }]] },
          PropagateAtLaunch: true,
          Value: 'owned',
        },
        {
          Key: 'Name',
          PropagateAtLaunch: true,
          Value: 'Stack/Cluster/Default',
        },
      ],
    });


  });

  test('create nodegroup with existing role', () => {
    // GIVEN
    const { stack } = testFixtureNoVpc();

    // WHEN
    const cluster = new eks.Cluster(stack, 'cluster', {
      defaultCapacity: 10,
      defaultCapacityInstance: new ec2.InstanceType('m2.xlarge'),
      version: CLUSTER_VERSION,
      prune: false,
    });

    const existingRole = new iam.Role(stack, 'ExistingRole', {
      assumedBy: new iam.AccountRootPrincipal(),
    });

    new eks.Nodegroup(stack, 'Nodegroup', {
      cluster,
      nodeRole: existingRole,
    });

    // THEN
    expect(cluster.defaultNodegroup).toBeDefined();
    expect(stack).toHaveResource('AWS::EKS::Nodegroup', {
      ScalingConfig: {
        DesiredSize: 10,
        MaxSize: 10,
        MinSize: 10,
      },
    });

  });

  test('adding bottlerocket capacity creates an ASG with tags', () => {
    // GIVEN
    const { stack, vpc } = testFixture();
    const cluster = new eks.Cluster(stack, 'Cluster', {
      vpc,
      defaultCapacity: 0,
      version: CLUSTER_VERSION,
      prune: false,
    });

    // WHEN
    cluster.addAutoScalingGroupCapacity('Bottlerocket', {
      instanceType: new ec2.InstanceType('t2.medium'),
      machineImageType: eks.MachineImageType.BOTTLEROCKET,
    });

    // THEN
    expect(stack).toHaveResource('AWS::AutoScaling::AutoScalingGroup', {
      Tags: [
        {
          Key: { 'Fn::Join': ['', ['kubernetes.io/cluster/', { Ref: 'Cluster9EE0221C' }]] },
          PropagateAtLaunch: true,
          Value: 'owned',
        },
        {
          Key: 'Name',
          PropagateAtLaunch: true,
          Value: 'Stack/Cluster/Bottlerocket',
        },
      ],
    });

  });

  test('adding bottlerocket capacity with bootstrapOptions throws error', () => {
    // GIVEN
    const { stack, vpc } = testFixture();
    const cluster = new eks.Cluster(stack, 'Cluster', {
      vpc,
      defaultCapacity: 0,
      version: CLUSTER_VERSION,
      prune: false,
    });

    expect(() => cluster.addAutoScalingGroupCapacity('Bottlerocket', {
      instanceType: new ec2.InstanceType('t2.medium'),
      machineImageType: eks.MachineImageType.BOTTLEROCKET,
      bootstrapOptions: {},
    })).toThrow(/bootstrapOptions is not supported for Bottlerocket/);

  });

  test('import cluster with new kubectl private subnets', () => {

    const { stack, vpc } = testFixture();

    const cluster = eks.Cluster.fromClusterAttributes(stack, 'Cluster', {
      clusterName: 'cluster',
      kubectlPrivateSubnetIds: vpc.privateSubnets.map(s => s.subnetId),
    });

    expect(cluster.kubectlPrivateSubnets?.map(s => stack.resolve(s.subnetId))).toEqual([
      { Ref: 'VPCPrivateSubnet1Subnet8BCA10E0' },
      { Ref: 'VPCPrivateSubnet2SubnetCFCDAA7A' },
    ]);

    expect(cluster.kubectlPrivateSubnets?.map(s => s.node.id)).toEqual([
      'KubectlSubnet0',
      'KubectlSubnet1',
    ]);


  });

  test('exercise export/import', () => {
    // GIVEN
    const { stack: stack1, vpc, app } = testFixture();
    const stack2 = new cdk.Stack(app, 'stack2', { env: { region: 'us-east-1' } });
    const cluster = new eks.Cluster(stack1, 'Cluster', {
      vpc,
      defaultCapacity: 0,
      version: CLUSTER_VERSION,
      prune: false,
    });

    // WHEN
    const imported = eks.Cluster.fromClusterAttributes(stack2, 'Imported', {
      vpc: cluster.vpc,
      clusterEndpoint: cluster.clusterEndpoint,
      clusterName: cluster.clusterName,
      securityGroupIds: cluster.connections.securityGroups.map(x => x.securityGroupId),
      clusterCertificateAuthorityData: cluster.clusterCertificateAuthorityData,
      clusterSecurityGroupId: cluster.clusterSecurityGroupId,
      clusterEncryptionConfigKeyArn: cluster.clusterEncryptionConfigKeyArn,
    });

    // this should cause an export/import
    new cdk.CfnOutput(stack2, 'ClusterARN', { value: imported.clusterArn });

    // THEN
    expect(stack2).toMatchTemplate({
      Outputs: {
        ClusterARN: {
          Value: {
            'Fn::Join': [
              '',
              [
                'arn:',
                {
                  Ref: 'AWS::Partition',
                },
                ':eks:us-east-1:',
                {
                  Ref: 'AWS::AccountId',
                },
                ':cluster/',
                {
                  'Fn::ImportValue': 'Stack:ExportsOutputRefCluster9EE0221C4853B4C3',
                },
              ],
            ],
          },
        },
      },
    });

  });

  test('mastersRole can be used to map an IAM role to "system:masters"', () => {
    // GIVEN
    const { stack, vpc } = testFixture();
    const role = new iam.Role(stack, 'role', { assumedBy: new iam.AnyPrincipal() });

    // WHEN
    new eks.Cluster(stack, 'Cluster', {
      vpc,
      mastersRole: role,
      defaultCapacity: 0,
      version: CLUSTER_VERSION,
      prune: false,
    });

    // THEN
    expect(stack).toHaveResource(eks.KubernetesManifest.RESOURCE_TYPE, {
      Manifest: {
        'Fn::Join': [
          '',
          [
            '[{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"aws-auth","namespace":"kube-system"},"data":{"mapRoles":"[{\\"rolearn\\":\\"',
            {
              'Fn::GetAtt': [
                'roleC7B7E775',
                'Arn',
              ],
            },
            '\\",\\"username\\":\\"',
            {
              'Fn::GetAtt': [
                'roleC7B7E775',
                'Arn',
              ],
            },
            '\\",\\"groups\\":[\\"system:masters\\"]}]","mapUsers":"[]","mapAccounts":"[]"}}]',
          ],
        ],
      },
    });


  });

  test('addManifest can be used to apply k8s manifests on this cluster', () => {
    // GIVEN
    const { stack, vpc } = testFixture();
    const cluster = new eks.Cluster(stack, 'Cluster', {
      vpc,
      defaultCapacity: 0,
      version: CLUSTER_VERSION,
      prune: false,
    });

    // WHEN
    cluster.addManifest('manifest1', { foo: 123 });
    cluster.addManifest('manifest2', { bar: 123 }, { boor: [1, 2, 3] });

    // THEN
    expect(stack).toHaveResource(eks.KubernetesManifest.RESOURCE_TYPE, {
      Manifest: '[{"foo":123}]',
    });

    expect(stack).toHaveResource(eks.KubernetesManifest.RESOURCE_TYPE, {
      Manifest: '[{"bar":123},{"boor":[1,2,3]}]',
    });


  });

  test('kubectl resources can be created in a separate stack', () => {
    // GIVEN
    const { stack, app } = testFixture();
    const cluster = new eks.Cluster(stack, 'cluster', { version: CLUSTER_VERSION, prune: false }); // cluster is under stack2

    // WHEN resource is under stack2
    const stack2 = new cdk.Stack(app, 'stack2', { env: { account: stack.account, region: stack.region } });
    new eks.KubernetesManifest(stack2, 'myresource', {
      cluster,
      manifest: [{ foo: 'bar' }],
    });

    // THEN
    app.synth(); // no cyclic dependency (see https://github.com/aws/aws-cdk/issues/7231)

    // expect a single resource in the 2nd stack
    expect(stack2).toMatchTemplate({
      Resources: {
        myresource49C6D325: {
          Type: 'Custom::AWSCDK-EKS-KubernetesResource',
          Properties: {
            ServiceToken: {
              'Fn::ImportValue': 'Stack:ExportsOutputFnGetAttawscdkawseksKubectlProviderNestedStackawscdkawseksKubectlProviderNestedStackResourceA7AEBA6BOutputsStackawscdkawseksKubectlProviderframeworkonEvent8897FD9BArn49BEF20C',
            },
            Manifest: '[{\"foo\":\"bar\"}]',
            ClusterName: { 'Fn::ImportValue': 'Stack:ExportsOutputRefclusterC5B25D0D98D553F5' },
            RoleArn: { 'Fn::ImportValue': 'Stack:ExportsOutputFnGetAttclusterCreationRole2B3B5002ArnF05122FC' },
          },
          UpdateReplacePolicy: 'Delete',
          DeletionPolicy: 'Delete',
        },
      },
    });


  });

  test('adding capacity will automatically map its IAM role', () => {
    // GIVEN
    const { stack, vpc } = testFixture();
    const cluster = new eks.Cluster(stack, 'Cluster', {
      vpc,
      defaultCapacity: 0,
      version: CLUSTER_VERSION,
      prune: false,
    });

    // WHEN
    cluster.addAutoScalingGroupCapacity('default', {
      instanceType: new ec2.InstanceType('t2.nano'),
    });

    // THEN
    expect(stack).toHaveResource(eks.KubernetesManifest.RESOURCE_TYPE, {
      Manifest: {
        'Fn::Join': [
          '',
          [
            '[{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"aws-auth","namespace":"kube-system"},"data":{"mapRoles":"[{\\"rolearn\\":\\"',
            {
              'Fn::GetAtt': [
                'ClusterMastersRole9AA35625',
                'Arn',
              ],
            },
            '\\",\\"username\\":\\"',
            {
              'Fn::GetAtt': [
                'ClusterMastersRole9AA35625',
                'Arn',
              ],
            },
            '\\",\\"groups\\":[\\"system:masters\\"]},{\\"rolearn\\":\\"',
            {
              'Fn::GetAtt': [
                'ClusterdefaultInstanceRoleF20A29CD',
                'Arn',
              ],
            },
            '\\",\\"username\\":\\"system:node:{{EC2PrivateDNSName}}\\",\\"groups\\":[\\"system:bootstrappers\\",\\"system:nodes\\"]}]","mapUsers":"[]","mapAccounts":"[]"}}]',
          ],
        ],
      },
    });


  });

  test('addAutoScalingGroupCapacity will *not* map the IAM role if mapRole is false', () => {
    // GIVEN
    const { stack, vpc } = testFixture();
    const cluster = new eks.Cluster(stack, 'Cluster', {
      vpc,
      defaultCapacity: 0,
      version: CLUSTER_VERSION,
      prune: false,
    });

    // WHEN
    cluster.addAutoScalingGroupCapacity('default', {
      instanceType: new ec2.InstanceType('t2.nano'),
      mapRole: false,
    });

    // THEN
    expect(stack).toHaveResource(eks.KubernetesManifest.RESOURCE_TYPE, {
      Manifest: {
        'Fn::Join': [
          '',
          [
            '[{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"aws-auth","namespace":"kube-system"},"data":{"mapRoles":"[{\\"rolearn\\":\\"',
            {
              'Fn::GetAtt': [
                'ClusterMastersRole9AA35625',
                'Arn',
              ],
            },
            '\\",\\"username\\":\\"',
            {
              'Fn::GetAtt': [
                'ClusterMastersRole9AA35625',
                'Arn',
              ],
            },
            '\\",\\"groups\\":[\\"system:masters\\"]}]","mapUsers":"[]","mapAccounts":"[]"}}]',
          ],
        ],
      },
    });

  });

  describe('outputs', () => {
    test('aws eks update-kubeconfig is the only output synthesized by default', () => {
      // GIVEN
      const { app, stack } = testFixtureNoVpc();

      // WHEN
      new eks.Cluster(stack, 'Cluster', { version: CLUSTER_VERSION, prune: false });

      // THEN
      const assembly = app.synth();
      const template = assembly.getStackByName(stack.stackName).template;
      expect(template.Outputs).toEqual({
        ClusterConfigCommand43AAE40F: { Value: { 'Fn::Join': ['', ['aws eks update-kubeconfig --name ', { Ref: 'Cluster9EE0221C' }, ' --region us-east-1 --role-arn ', { 'Fn::GetAtt': ['ClusterMastersRole9AA35625', 'Arn'] }]] } },
        ClusterGetTokenCommand06AE992E: { Value: { 'Fn::Join': ['', ['aws eks get-token --cluster-name ', { Ref: 'Cluster9EE0221C' }, ' --region us-east-1 --role-arn ', { 'Fn::GetAtt': ['ClusterMastersRole9AA35625', 'Arn'] }]] } },
      });

    });

    test('if masters role is defined, it should be included in the config command', () => {
      // GIVEN
      const { app, stack } = testFixtureNoVpc();

      // WHEN
      const mastersRole = new iam.Role(stack, 'masters', { assumedBy: new iam.AccountRootPrincipal() });
      new eks.Cluster(stack, 'Cluster', {
        mastersRole,
        version: CLUSTER_VERSION,
        prune: false,
      });

      // THEN
      const assembly = app.synth();
      const template = assembly.getStackByName(stack.stackName).template;
      expect(template.Outputs).toEqual({
        ClusterConfigCommand43AAE40F: { Value: { 'Fn::Join': ['', ['aws eks update-kubeconfig --name ', { Ref: 'Cluster9EE0221C' }, ' --region us-east-1 --role-arn ', { 'Fn::GetAtt': ['masters0D04F23D', 'Arn'] }]] } },
        ClusterGetTokenCommand06AE992E: { Value: { 'Fn::Join': ['', ['aws eks get-token --cluster-name ', { Ref: 'Cluster9EE0221C' }, ' --region us-east-1 --role-arn ', { 'Fn::GetAtt': ['masters0D04F23D', 'Arn'] }]] } },
      });

    });

    test('if `outputConfigCommand=false` will disabled the output', () => {
      // GIVEN
      const { app, stack } = testFixtureNoVpc();

      // WHEN
      const mastersRole = new iam.Role(stack, 'masters', { assumedBy: new iam.AccountRootPrincipal() });
      new eks.Cluster(stack, 'Cluster', {
        mastersRole,
        outputConfigCommand: false,
        version: CLUSTER_VERSION,
        prune: false,
      });

      // THEN
      const assembly = app.synth();
      const template = assembly.getStackByName(stack.stackName).template;
      expect(template.Outputs).toBeUndefined(); // no outputs

    });

    test('`outputClusterName` can be used to synthesize an output with the cluster name', () => {
      // GIVEN
      const { app, stack } = testFixtureNoVpc();

      // WHEN
      new eks.Cluster(stack, 'Cluster', {
        outputConfigCommand: false,
        outputClusterName: true,
        version: CLUSTER_VERSION,
        prune: false,
      });

      // THEN
      const assembly = app.synth();
      const template = assembly.getStackByName(stack.stackName).template;
      expect(template.Outputs).toEqual({
        ClusterClusterNameEB26049E: { Value: { Ref: 'Cluster9EE0221C' } },
      });

    });

    test('`outputMastersRoleArn` can be used to synthesize an output with the arn of the masters role if defined', () => {
      // GIVEN
      const { app, stack } = testFixtureNoVpc();

      // WHEN
      new eks.Cluster(stack, 'Cluster', {
        outputConfigCommand: false,
        outputMastersRoleArn: true,
        mastersRole: new iam.Role(stack, 'masters', { assumedBy: new iam.AccountRootPrincipal() }),
        version: CLUSTER_VERSION,
        prune: false,
      });

      // THEN
      const assembly = app.synth();
      const template = assembly.getStackByName(stack.stackName).template;
      expect(template.Outputs).toEqual({
        ClusterMastersRoleArnB15964B1: { Value: { 'Fn::GetAtt': ['masters0D04F23D', 'Arn'] } },
      });

    });

    describe('boostrap user-data', () => {

      test('rendered by default for ASGs', () => {
        // GIVEN
        const { app, stack } = testFixtureNoVpc();
        const cluster = new eks.Cluster(stack, 'Cluster', { defaultCapacity: 0, version: CLUSTER_VERSION, prune: false });

        // WHEN
        cluster.addAutoScalingGroupCapacity('MyCapcity', { instanceType: new ec2.InstanceType('m3.xlargs') });

        // THEN
        const template = app.synth().getStackByName(stack.stackName).template;
        const userData = template.Resources.ClusterMyCapcityLaunchConfig58583345.Properties.UserData;
        expect(userData).toEqual({ 'Fn::Base64': { 'Fn::Join': ['', ['#!/bin/bash\nset -o xtrace\n/etc/eks/bootstrap.sh ', { Ref: 'Cluster9EE0221C' }, ' --kubelet-extra-args "--node-labels lifecycle=OnDemand" --apiserver-endpoint \'', { 'Fn::GetAtt': ['Cluster9EE0221C', 'Endpoint'] }, '\' --b64-cluster-ca \'', { 'Fn::GetAtt': ['Cluster9EE0221C', 'CertificateAuthorityData'] }, '\' --use-max-pods true\n/opt/aws/bin/cfn-signal --exit-code $? --stack Stack --resource ClusterMyCapcityASGD4CD8B97 --region us-east-1']] } });

      });

      test('not rendered if bootstrap is disabled', () => {
        // GIVEN
        const { app, stack } = testFixtureNoVpc();
        const cluster = new eks.Cluster(stack, 'Cluster', { defaultCapacity: 0, version: CLUSTER_VERSION, prune: false });

        // WHEN
        cluster.addAutoScalingGroupCapacity('MyCapcity', {
          instanceType: new ec2.InstanceType('m3.xlargs'),
          bootstrapEnabled: false,
        });

        // THEN
        const template = app.synth().getStackByName(stack.stackName).template;
        const userData = template.Resources.ClusterMyCapcityLaunchConfig58583345.Properties.UserData;
        expect(userData).toEqual({ 'Fn::Base64': '#!/bin/bash' });

      });

      // cursory test for options: see test.user-data.ts for full suite
      test('bootstrap options', () => {
        // GIVEN
        const { app, stack } = testFixtureNoVpc();
        const cluster = new eks.Cluster(stack, 'Cluster', { defaultCapacity: 0, version: CLUSTER_VERSION, prune: false });

        // WHEN
        cluster.addAutoScalingGroupCapacity('MyCapcity', {
          instanceType: new ec2.InstanceType('m3.xlargs'),
          bootstrapOptions: {
            kubeletExtraArgs: '--node-labels FOO=42',
          },
        });

        // THEN
        const template = app.synth().getStackByName(stack.stackName).template;
        const userData = template.Resources.ClusterMyCapcityLaunchConfig58583345.Properties.UserData;
        expect(userData).toEqual({ 'Fn::Base64': { 'Fn::Join': ['', ['#!/bin/bash\nset -o xtrace\n/etc/eks/bootstrap.sh ', { Ref: 'Cluster9EE0221C' }, ' --kubelet-extra-args "--node-labels lifecycle=OnDemand  --node-labels FOO=42" --apiserver-endpoint \'', { 'Fn::GetAtt': ['Cluster9EE0221C', 'Endpoint'] }, '\' --b64-cluster-ca \'', { 'Fn::GetAtt': ['Cluster9EE0221C', 'CertificateAuthorityData'] }, '\' --use-max-pods true\n/opt/aws/bin/cfn-signal --exit-code $? --stack Stack --resource ClusterMyCapcityASGD4CD8B97 --region us-east-1']] } });

      });

      describe('spot instances', () => {

        test('nodes labeled an tainted accordingly', () => {
          // GIVEN
          const { app, stack } = testFixtureNoVpc();
          const cluster = new eks.Cluster(stack, 'Cluster', { defaultCapacity: 0, version: CLUSTER_VERSION, prune: false });

          // WHEN
          cluster.addAutoScalingGroupCapacity('MyCapcity', {
            instanceType: new ec2.InstanceType('m3.xlargs'),
            spotPrice: '0.01',
          });

          // THEN
          const template = app.synth().getStackByName(stack.stackName).template;
          const userData = template.Resources.ClusterMyCapcityLaunchConfig58583345.Properties.UserData;
          expect(userData).toEqual({ 'Fn::Base64': { 'Fn::Join': ['', ['#!/bin/bash\nset -o xtrace\n/etc/eks/bootstrap.sh ', { Ref: 'Cluster9EE0221C' }, ' --kubelet-extra-args "--node-labels lifecycle=Ec2Spot --register-with-taints=spotInstance=true:PreferNoSchedule" --apiserver-endpoint \'', { 'Fn::GetAtt': ['Cluster9EE0221C', 'Endpoint'] }, '\' --b64-cluster-ca \'', { 'Fn::GetAtt': ['Cluster9EE0221C', 'CertificateAuthorityData'] }, '\' --use-max-pods true\n/opt/aws/bin/cfn-signal --exit-code $? --stack Stack --resource ClusterMyCapcityASGD4CD8B97 --region us-east-1']] } });

        });

        test('interrupt handler is added', () => {
          // GIVEN
          const { stack } = testFixtureNoVpc();
          const cluster = new eks.Cluster(stack, 'Cluster', { defaultCapacity: 0, version: CLUSTER_VERSION, prune: false });

          // WHEN
          cluster.addAutoScalingGroupCapacity('MyCapcity', {
            instanceType: new ec2.InstanceType('m3.xlarge'),
            spotPrice: '0.01',
          });

          // THEN
          expect(stack).toHaveResource(eks.HelmChart.RESOURCE_TYPE, {
            Release: 'stackclusterchartspotinterrupthandlerdec62e07',
            Chart: 'aws-node-termination-handler',
            Values: '{\"nodeSelector\":{\"lifecycle\":\"Ec2Spot\"}}',
            Namespace: 'kube-system',
            Repository: 'https://aws.github.io/eks-charts',
          });

        });

        test('interrupt handler is not added when spotInterruptHandler is false', () => {
          // GIVEN
          const { stack } = testFixtureNoVpc();
          const cluster = new eks.Cluster(stack, 'Cluster', { defaultCapacity: 0, version: CLUSTER_VERSION, prune: false });

          // WHEN
          cluster.addAutoScalingGroupCapacity('MyCapcity', {
            instanceType: new ec2.InstanceType('m3.xlarge'),
            spotPrice: '0.01',
            spotInterruptHandler: false,
          });

          // THEN
          expect(cluster.node.findAll().filter(c => c.node.id === 'chart-spot-interrupt-handler').length).toEqual(0);

        });

        test('its possible to add two capacities with spot instances and only one stop handler will be installed', () => {
          // GIVEN
          const { stack } = testFixtureNoVpc();
          const cluster = new eks.Cluster(stack, 'Cluster', { defaultCapacity: 0, version: CLUSTER_VERSION, prune: false });

          // WHEN
          cluster.addAutoScalingGroupCapacity('Spot1', {
            instanceType: new ec2.InstanceType('m3.xlarge'),
            spotPrice: '0.01',
          });

          cluster.addAutoScalingGroupCapacity('Spot2', {
            instanceType: new ec2.InstanceType('m4.xlarge'),
            spotPrice: '0.01',
          });

          // THEN
          expect(stack).toCountResources(eks.HelmChart.RESOURCE_TYPE, 1);

        });

      });

    });

    test('if bootstrap is disabled cannot specify options', () => {
      // GIVEN
      const { stack } = testFixtureNoVpc();
      const cluster = new eks.Cluster(stack, 'Cluster', { defaultCapacity: 0, version: CLUSTER_VERSION, prune: false });

      // THEN
      expect(() => cluster.addAutoScalingGroupCapacity('MyCapcity', {
        instanceType: new ec2.InstanceType('m3.xlargs'),
        bootstrapEnabled: false,
        bootstrapOptions: { awsApiRetryAttempts: 10 },
      })).toThrow(/Cannot specify "bootstrapOptions" if "bootstrapEnabled" is false/);

    });

    test('EksOptimizedImage() with no nodeType always uses STANDARD with LATEST_KUBERNETES_VERSION', () => {
      // GIVEN
      const { app, stack } = testFixtureNoVpc();
      const LATEST_KUBERNETES_VERSION = '1.14';

      // WHEN
      new eks.EksOptimizedImage().getImage(stack);

      // THEN
      const assembly = app.synth();
      const parameters = assembly.getStackByName(stack.stackName).template.Parameters;
      expect(Object.entries(parameters).some(
        ([k, v]) => k.startsWith('SsmParameterValueawsserviceeksoptimizedami') &&
          (v as any).Default.includes('/amazon-linux-2/'),
      )).toEqual(true);
      expect(Object.entries(parameters).some(
        ([k, v]) => k.startsWith('SsmParameterValueawsserviceeksoptimizedami') &&
          (v as any).Default.includes(LATEST_KUBERNETES_VERSION),
      )).toEqual(true);

    });

    test('EksOptimizedImage() with specific kubernetesVersion return correct AMI', () => {
      // GIVEN
      const { app, stack } = testFixtureNoVpc();

      // WHEN
      new eks.EksOptimizedImage({ kubernetesVersion: '1.21' }).getImage(stack);

      // THEN
      const assembly = app.synth();
      const parameters = assembly.getStackByName(stack.stackName).template.Parameters;
      expect(Object.entries(parameters).some(
        ([k, v]) => k.startsWith('SsmParameterValueawsserviceeksoptimizedami') &&
          (v as any).Default.includes('/amazon-linux-2/'),
      )).toEqual(true);
      expect(Object.entries(parameters).some(
        ([k, v]) => k.startsWith('SsmParameterValueawsserviceeksoptimizedami') &&
          (v as any).Default.includes('/1.21/'),
      )).toEqual(true);

    });

    test('default cluster capacity with ARM64 instance type comes with nodegroup with correct AmiType', () => {
      // GIVEN
      const { stack } = testFixtureNoVpc();

      // WHEN
      new eks.Cluster(stack, 'cluster', {
        defaultCapacity: 1,
        version: CLUSTER_VERSION,
        prune: false,
        defaultCapacityInstance: new ec2.InstanceType('m6g.medium'),
      });

      // THEN
      expect(stack).toHaveResourceLike('AWS::EKS::Nodegroup', {
        AmiType: 'AL2_ARM_64',
      });

    });

    test('addNodegroup with ARM64 instance type comes with nodegroup with correct AmiType', () => {
      // GIVEN
      const { stack } = testFixtureNoVpc();

      // WHEN
      new eks.Cluster(stack, 'cluster', {
        defaultCapacity: 0,
        version: CLUSTER_VERSION,
        prune: false,
        defaultCapacityInstance: new ec2.InstanceType('m6g.medium'),
      }).addNodegroupCapacity('ng', {
        instanceType: new ec2.InstanceType('m6g.medium'),
      });

      // THEN
      expect(stack).toHaveResourceLike('AWS::EKS::Nodegroup', {
        AmiType: 'AL2_ARM_64',
      });

    });

    test('addNodegroupCapacity with T4g instance type comes with nodegroup with correct AmiType', () => {
      // GIVEN
      const { stack } = testFixtureNoVpc();

      // WHEN
      new eks.Cluster(stack, 'cluster', {
        defaultCapacity: 0,
        version: CLUSTER_VERSION,
        prune: false,
        defaultCapacityInstance: new ec2.InstanceType('t4g.medium'),
      }).addNodegroupCapacity('ng', {
        instanceType: new ec2.InstanceType('t4g.medium'),
      });

      // THEN
      expect(stack).toHaveResourceLike('AWS::EKS::Nodegroup', {
        AmiType: 'AL2_ARM_64',
      });

    });

    test('addAutoScalingGroupCapacity with T4g instance type comes with nodegroup with correct AmiType', () => {
      // GIVEN
      const { app, stack } = testFixtureNoVpc();

      // WHEN
      new eks.Cluster(stack, 'cluster', {
        defaultCapacity: 0,
        version: CLUSTER_VERSION,
        prune: false,
      }).addAutoScalingGroupCapacity('ng', {
        instanceType: new ec2.InstanceType('t4g.medium'),
      });

      // THEN
      const assembly = app.synth();
      const parameters = assembly.getStackByName(stack.stackName).template.Parameters;
      expect(Object.entries(parameters).some(
        ([k, v]) => k.startsWith('SsmParameterValueawsserviceeksoptimizedami') &&
          (v as any).Default.includes('amazon-linux-2-arm64/'),
      )).toEqual(true);

    });

    test('EKS-Optimized AMI with GPU support when addAutoScalingGroupCapacity', () => {
      // GIVEN
      const { app, stack } = testFixtureNoVpc();

      // WHEN
      new eks.Cluster(stack, 'cluster', {
        defaultCapacity: 0,
        version: CLUSTER_VERSION,
        prune: false,
      }).addAutoScalingGroupCapacity('GPUCapacity', {
        instanceType: new ec2.InstanceType('g4dn.xlarge'),
      });

      // THEN
      const assembly = app.synth();
      const parameters = assembly.getStackByName(stack.stackName).template.Parameters;
      expect(Object.entries(parameters).some(
        ([k, v]) => k.startsWith('SsmParameterValueawsserviceeksoptimizedami') && (v as any).Default.includes('amazon-linux-2-gpu'),
      )).toEqual(true);

    });

    test('EKS-Optimized AMI with ARM64 when addAutoScalingGroupCapacity', () => {
      // GIVEN
      const { app, stack } = testFixtureNoVpc();

      // WHEN
      new eks.Cluster(stack, 'cluster', {
        defaultCapacity: 0,
        version: CLUSTER_VERSION,
        prune: false,
      }).addAutoScalingGroupCapacity('ARMCapacity', {
        instanceType: new ec2.InstanceType('m6g.medium'),
      });

      // THEN
      const assembly = app.synth();
      const parameters = assembly.getStackByName(stack.stackName).template.Parameters;
      expect(Object.entries(parameters).some(
        ([k, v]) => k.startsWith('SsmParameterValueawsserviceeksoptimizedami') && (v as any).Default.includes('/amazon-linux-2-arm64/'),
      )).toEqual(true);

    });

    test('BottleRocketImage() with specific kubernetesVersion return correct AMI', () => {
      // GIVEN
      const { app, stack } = testFixtureNoVpc();

      // WHEN
      new BottleRocketImage({ kubernetesVersion: '1.21' }).getImage(stack);

      // THEN
      const assembly = app.synth();
      const parameters = assembly.getStackByName(stack.stackName).template.Parameters;
      expect(Object.entries(parameters).some(
        ([k, v]) => k.startsWith('SsmParameterValueawsservicebottlerocketaws') &&
          (v as any).Default.includes('/bottlerocket/'),
      )).toEqual(true);
      expect(Object.entries(parameters).some(
        ([k, v]) => k.startsWith('SsmParameterValueawsservicebottlerocketaws') &&
          (v as any).Default.includes('/aws-k8s-1.21/'),
      )).toEqual(true);

    });

    test('when using custom resource a creation role & policy is defined', () => {
      // GIVEN
      const { stack } = testFixture();

      // WHEN
      new eks.Cluster(stack, 'MyCluster', {
        clusterName: 'my-cluster-name',
        version: CLUSTER_VERSION,
        prune: false,
      });

      // THEN
      expect(stack).toHaveResource('Custom::AWSCDK-EKS-Cluster', {
        Config: {
          name: 'my-cluster-name',
          roleArn: { 'Fn::GetAtt': ['MyClusterRoleBA20FE72', 'Arn'] },
          version: '1.21',
          resourcesVpcConfig: {
            securityGroupIds: [
              { 'Fn::GetAtt': ['MyClusterControlPlaneSecurityGroup6B658F79', 'GroupId'] },
            ],
            subnetIds: [
              { Ref: 'MyClusterDefaultVpcPublicSubnet1SubnetFAE5A9B6' },
              { Ref: 'MyClusterDefaultVpcPublicSubnet2SubnetF6D028A0' },
              { Ref: 'MyClusterDefaultVpcPrivateSubnet1SubnetE1D0DCDB' },
              { Ref: 'MyClusterDefaultVpcPrivateSubnet2Subnet11FEA8D0' },
            ],
            endpointPrivateAccess: true,
            endpointPublicAccess: true,
          },
        },
      });

      // role can be assumed by 3 lambda handlers (2 for the cluster resource and 1 for the kubernetes resource)
      expect(stack).toHaveResource('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: 'sts:AssumeRole',
              Effect: 'Allow',
              Principal: {
                AWS: {
                  'Fn::Join': [
                    '',
                    ['arn:', { Ref: 'AWS::Partition' }, ':iam::', { Ref: 'AWS::AccountId' }, ':root'],
                  ],
                },
              },
            },
          ],
          Version: '2012-10-17',
        },
      });

      // policy allows creation role to pass the cluster role and to interact with the cluster (given we know the explicit cluster name)
      expect(stack).toHaveResource('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: [
            {
              Action: 'iam:PassRole',
              Effect: 'Allow',
              Resource: {
                'Fn::GetAtt': [
                  'MyClusterRoleBA20FE72',
                  'Arn',
                ],
              },
            },
            {
              Action: [
                'eks:CreateCluster',
                'eks:DescribeCluster',
                'eks:DescribeUpdate',
                'eks:DeleteCluster',
                'eks:UpdateClusterVersion',
                'eks:UpdateClusterConfig',
                'eks:CreateFargateProfile',
                'eks:TagResource',
                'eks:UntagResource',
              ],
              Effect: 'Allow',
              Resource: [{
                'Fn::Join': [
                  '',
                  [
                    'arn:',
                    {
                      Ref: 'AWS::Partition',
                    },
                    ':eks:us-east-1:',
                    {
                      Ref: 'AWS::AccountId',
                    },
                    ':cluster/my-cluster-name',
                  ],
                ],
              }, {
                'Fn::Join': [
                  '',
                  [
                    'arn:',
                    {
                      Ref: 'AWS::Partition',
                    },
                    ':eks:us-east-1:',
                    {
                      Ref: 'AWS::AccountId',
                    },
                    ':cluster/my-cluster-name/*',
                  ],
                ],
              }],
            },
            {
              Action: [
                'eks:DescribeFargateProfile',
                'eks:DeleteFargateProfile',
              ],
              Effect: 'Allow',
              Resource: {
                'Fn::Join': [
                  '',
                  [
                    'arn:',
                    {
                      Ref: 'AWS::Partition',
                    },
                    ':eks:us-east-1:',
                    {
                      Ref: 'AWS::AccountId',
                    },
                    ':fargateprofile/my-cluster-name/*',
                  ],
                ],
              },
            },
            {
              Action: ['iam:GetRole', 'iam:listAttachedRolePolicies'],
              Effect: 'Allow',
              Resource: '*',
            },
            {
              Action: 'iam:CreateServiceLinkedRole',
              Effect: 'Allow',
              Resource: '*',
            },
            {
              Action: [
                'ec2:DescribeInstances',
                'ec2:DescribeNetworkInterfaces',
                'ec2:DescribeSecurityGroups',
                'ec2:DescribeSubnets',
                'ec2:DescribeRouteTables',
                'ec2:DescribeDhcpOptions',
                'ec2:DescribeVpcs',
              ],
              Effect: 'Allow',
              Resource: '*',
            },
          ],
          Version: '2012-10-17',
        },
      });

    });

    test('if an explicit cluster name is not provided, the creation role policy is wider (allows interacting with all clusters)', () => {
      // GIVEN
      const { stack } = testFixture();

      // WHEN
      new eks.Cluster(stack, 'MyCluster', { version: CLUSTER_VERSION, prune: false });

      // THEN
      expect(stack).toHaveResource('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: [
            {
              Action: 'iam:PassRole',
              Effect: 'Allow',
              Resource: {
                'Fn::GetAtt': [
                  'MyClusterRoleBA20FE72',
                  'Arn',
                ],
              },
            },
            {
              Action: [
                'eks:CreateCluster',
                'eks:DescribeCluster',
                'eks:DescribeUpdate',
                'eks:DeleteCluster',
                'eks:UpdateClusterVersion',
                'eks:UpdateClusterConfig',
                'eks:CreateFargateProfile',
                'eks:TagResource',
                'eks:UntagResource',
              ],
              Effect: 'Allow',
              Resource: ['*'],
            },
            {
              Action: [
                'eks:DescribeFargateProfile',
                'eks:DeleteFargateProfile',
              ],
              Effect: 'Allow',
              Resource: '*',
            },
            {
              Action: ['iam:GetRole', 'iam:listAttachedRolePolicies'],
              Effect: 'Allow',
              Resource: '*',
            },
            {
              Action: 'iam:CreateServiceLinkedRole',
              Effect: 'Allow',
              Resource: '*',
            },
            {
              Action: [
                'ec2:DescribeInstances',
                'ec2:DescribeNetworkInterfaces',
                'ec2:DescribeSecurityGroups',
                'ec2:DescribeSubnets',
                'ec2:DescribeRouteTables',
                'ec2:DescribeDhcpOptions',
                'ec2:DescribeVpcs',
              ],
              Effect: 'Allow',
              Resource: '*',
            },
          ],
          Version: '2012-10-17',
        },
      });

    });

    test('if helm charts are used, the provider role is allowed to assume the creation role', () => {
      // GIVEN
      const { stack } = testFixture();
      const cluster = new eks.Cluster(stack, 'MyCluster', {
        clusterName: 'my-cluster-name',
        version: CLUSTER_VERSION,
        prune: false,
      });

      // WHEN
      cluster.addHelmChart('MyChart', {
        chart: 'foo',
      });

      // THEN

      const providerStack = stack.node.tryFindChild('@aws-cdk/aws-eks.KubectlProvider') as cdk.NestedStack;
      expect(providerStack).toHaveResource('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: [
            {
              Action: 'eks:DescribeCluster',
              Effect: 'Allow',
              Resource: {
                Ref: 'referencetoStackMyClusterD33CAEABArn',
              },
            },
            {
              Action: 'sts:AssumeRole',
              Effect: 'Allow',
              Resource: {
                Ref: 'referencetoStackMyClusterCreationRoleA67486E4Arn',
              },
            },
          ],
          Version: '2012-10-17',
        },
        PolicyName: 'HandlerServiceRoleDefaultPolicyCBD0CC91',
        Roles: [
          {
            Ref: 'HandlerServiceRoleFCDC14AE',
          },
        ],
      });


    });

    test('coreDnsComputeType will patch the coreDNS configuration to use a "fargate" compute type and restore to "ec2" upon removal', () => {
      // GIVEN
      const stack = new cdk.Stack();

      // WHEN
      new eks.Cluster(stack, 'MyCluster', {
        coreDnsComputeType: eks.CoreDnsComputeType.FARGATE,
        version: CLUSTER_VERSION,
        prune: false,
      });

      // THEN
      expect(stack).toHaveResource('Custom::AWSCDK-EKS-KubernetesPatch', {
        ResourceName: 'deployment/coredns',
        ResourceNamespace: 'kube-system',
        ApplyPatchJson: '{"spec":{"template":{"metadata":{"annotations":{"eks.amazonaws.com/compute-type":"fargate"}}}}}',
        RestorePatchJson: '{"spec":{"template":{"metadata":{"annotations":{"eks.amazonaws.com/compute-type":"ec2"}}}}}',
        ClusterName: {
          Ref: 'MyCluster8AD82BF8',
        },
        RoleArn: {
          'Fn::GetAtt': [
            'MyClusterCreationRoleB5FA4FF3',
            'Arn',
          ],
        },
      });

    });
    test('if openIDConnectProvider a new OpenIDConnectProvider resource is created and exposed', () => {
      // GIVEN
      const { stack } = testFixtureNoVpc();
      const cluster = new eks.Cluster(stack, 'Cluster', { defaultCapacity: 0, version: CLUSTER_VERSION, prune: false });

      // WHEN
      const provider = cluster.openIdConnectProvider;

      // THEN
      expect(provider).toEqual(cluster.openIdConnectProvider);
      expect(stack).toHaveResource('Custom::AWSCDKOpenIdConnectProvider', {
        ServiceToken: {
          'Fn::GetAtt': [
            'CustomAWSCDKOpenIdConnectProviderCustomResourceProviderHandlerF2C543E0',
            'Arn',
          ],
        },
        ClientIDList: [
          'sts.amazonaws.com',
        ],
        ThumbprintList: [
          '9e99a48a9960b14926bb7f3b02e22da2b0ab7280',
        ],
        Url: {
          'Fn::GetAtt': [
            'Cluster9EE0221C',
            'OpenIdConnectIssuerUrl',
          ],
        },
      });

    });
    test('inference instances are supported', () => {
      // GIVEN
      const { stack } = testFixtureNoVpc();
      const cluster = new eks.Cluster(stack, 'Cluster', { defaultCapacity: 0, version: CLUSTER_VERSION, prune: false });

      // WHEN
      cluster.addAutoScalingGroupCapacity('InferenceInstances', {
        instanceType: new ec2.InstanceType('inf1.2xlarge'),
        minCapacity: 1,
      });
      const fileContents = fs.readFileSync(path.join(__dirname, '../lib', 'addons/neuron-device-plugin.yaml'), 'utf8');
      const sanitized = YAML.parse(fileContents);

      // THEN
      expect(stack).toHaveResource(eks.KubernetesManifest.RESOURCE_TYPE, {
        Manifest: JSON.stringify([sanitized]),
      });

    });

    test('kubectl resources are always created after all fargate profiles', () => {
      // GIVEN
      const { stack, app } = testFixture();
      const cluster = new eks.Cluster(stack, 'Cluster', { version: CLUSTER_VERSION, prune: false });

      // WHEN
      cluster.addFargateProfile('profile1', { selectors: [{ namespace: 'profile1' }] });
      cluster.addManifest('resource1', { foo: 123 });
      cluster.addFargateProfile('profile2', { selectors: [{ namespace: 'profile2' }] });
      new eks.HelmChart(stack, 'chart', { cluster, chart: 'mychart' });
      cluster.addFargateProfile('profile3', { selectors: [{ namespace: 'profile3' }] });
      new eks.KubernetesPatch(stack, 'patch1', {
        cluster,
        applyPatch: { foo: 123 },
        restorePatch: { bar: 123 },
        resourceName: 'foo/bar',
      });
      cluster.addFargateProfile('profile4', { selectors: [{ namespace: 'profile4' }] });

      // THEN
      const template = app.synth().getStackArtifact(stack.artifactId).template;

      const barrier = template.Resources.ClusterKubectlReadyBarrier200052AF;

      expect(barrier.DependsOn).toEqual([
        'Clusterfargateprofileprofile1PodExecutionRoleE85F87B5',
        'Clusterfargateprofileprofile129AEA3C6',
        'Clusterfargateprofileprofile2PodExecutionRole22670AF8',
        'Clusterfargateprofileprofile233B9A117',
        'Clusterfargateprofileprofile3PodExecutionRole475C0D8F',
        'Clusterfargateprofileprofile3D06F3076',
        'Clusterfargateprofileprofile4PodExecutionRole086057FB',
        'Clusterfargateprofileprofile4A0E3BBE8',
        'ClusterCreationRoleDefaultPolicyE8BDFC7B',
        'ClusterCreationRole360249B6',
        'Cluster9EE0221C',
      ]);

      const kubectlResources = ['chartF2447AFC', 'patch1B964AC93', 'Clustermanifestresource10B1C9505', 'ClusterAwsAuthmanifestFE51F8AE'];

      // check that all kubectl resources depend on the barrier
      for (const r of kubectlResources) {
        expect(template.Resources[r].DependsOn).toEqual(['ClusterKubectlReadyBarrier200052AF']);
      }


    });

    test('kubectl provider role can assume creation role', () => {
      // GIVEN
      const { stack } = testFixture();
      const c1 = new eks.Cluster(stack, 'Cluster1', { version: CLUSTER_VERSION, prune: false });

      // WHEN

      // activate kubectl provider
      c1.addManifest('c1a', { foo: 123 });
      c1.addManifest('c1b', { foo: 123 });

      // THEN
      const providerStack = stack.node.tryFindChild('@aws-cdk/aws-eks.KubectlProvider') as cdk.NestedStack;
      expect(providerStack).toHaveResource('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: [
            {
              Action: 'eks:DescribeCluster',
              Effect: 'Allow',
              Resource: {
                Ref: 'referencetoStackCluster18DFEAC17Arn',
              },
            },
            {
              Action: 'sts:AssumeRole',
              Effect: 'Allow',
              Resource: {
                Ref: 'referencetoStackCluster1CreationRoleEF7C9BBCArn',
              },
            },
          ],
          Version: '2012-10-17',
        },
      });

    });

  });

  test('kubectl provider passes security group to provider', () => {

    const { stack } = testFixture();

    new eks.Cluster(stack, 'Cluster1', {
      version: CLUSTER_VERSION,
      prune: false,
      endpointAccess: eks.EndpointAccess.PRIVATE,
      kubectlEnvironment: {
        Foo: 'Bar',
      },
    });

    // the kubectl provider is inside a nested stack.
    const nested = stack.node.tryFindChild('@aws-cdk/aws-eks.KubectlProvider') as cdk.NestedStack;
    const template = SynthUtils.toCloudFormation(nested);
    expect(template.Resources.ProviderframeworkonEvent83C1D0A7.Properties.VpcConfig.SecurityGroupIds).toEqual(
      [{ Ref: 'referencetoStackCluster18DFEAC17ClusterSecurityGroupId' }]);


  });

  test('kubectl provider passes environment to lambda', () => {

    const { stack } = testFixture();

    const cluster = new eks.Cluster(stack, 'Cluster1', {
      version: CLUSTER_VERSION,
      prune: false,
      endpointAccess: eks.EndpointAccess.PRIVATE,
      kubectlEnvironment: {
        Foo: 'Bar',
      },
    });

    cluster.addManifest('resource', {
      kind: 'ConfigMap',
      apiVersion: 'v1',
      data: {
        hello: 'world',
      },
      metadata: {
        name: 'config-map',
      },
    });

    // the kubectl provider is inside a nested stack.
    const nested = stack.node.tryFindChild('@aws-cdk/aws-eks.KubectlProvider') as cdk.NestedStack;
    expect(nested).toHaveResource('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          Foo: 'Bar',
        },
      },
    });


  });

  describe('endpoint access', () => {

    test('public restricted', () => {

      expect(() => {
        eks.EndpointAccess.PUBLIC.onlyFrom('1.2.3.4/32');
      }).toThrow(/Cannot restric public access to endpoint when private access is disabled. Use PUBLIC_AND_PRIVATE.onlyFrom\(\) instead./);


    });

    test('public non restricted without private subnets', () => {
      const { stack } = testFixture();

      new eks.Cluster(stack, 'Cluster', {
        version: CLUSTER_VERSION,
        prune: false,
        endpointAccess: eks.EndpointAccess.PUBLIC,
        vpcSubnets: [{ subnetType: ec2.SubnetType.PUBLIC }],
      });

      const nested = stack.node.tryFindChild('@aws-cdk/aws-eks.KubectlProvider') as cdk.NestedStack;
      const template = SynthUtils.toCloudFormation(nested);

      // we don't attach vpc config in case endpoint is public only, regardless of whether
      // the vpc has private subnets or not.
      expect(template.Resources.Handler886CB40B.Properties.VpcConfig).toEqual(undefined);


    });

    test('public non restricted with private subnets', () => {

      const { stack } = testFixture();

      new eks.Cluster(stack, 'Cluster', {
        version: CLUSTER_VERSION,
        prune: false,
        endpointAccess: eks.EndpointAccess.PUBLIC,
      });

      const nested = stack.node.tryFindChild('@aws-cdk/aws-eks.KubectlProvider') as cdk.NestedStack;
      const template = SynthUtils.toCloudFormation(nested);

      // we don't attach vpc config in case endpoint is public only, regardless of whether
      // the vpc has private subnets or not.
      expect(template.Resources.Handler886CB40B.Properties.VpcConfig).toEqual(undefined);


    });

    test('private without private subnets', () => {
      const { stack } = testFixture();

      expect(() => {
        new eks.Cluster(stack, 'Cluster', {
          version: CLUSTER_VERSION,
          prune: false,
          endpointAccess: eks.EndpointAccess.PRIVATE,
          vpcSubnets: [{ subnetType: ec2.SubnetType.PUBLIC }],
        });
      }).toThrow(/Vpc must contain private subnets when public endpoint access is disabled/);


    });

    test('private with private subnets', () => {

      const { stack } = testFixture();

      new eks.Cluster(stack, 'Cluster', {
        version: CLUSTER_VERSION,
        prune: false,
        endpointAccess: eks.EndpointAccess.PRIVATE,
      });

      const nested = stack.node.tryFindChild('@aws-cdk/aws-eks.KubectlProvider') as cdk.NestedStack;
      const template = SynthUtils.toCloudFormation(nested);

      // handler should have vpc config
      expect(template.Resources.Handler886CB40B.Properties.VpcConfig.SubnetIds.length).not.toEqual(0);
      expect(template.Resources.Handler886CB40B.Properties.VpcConfig.SecurityGroupIds.length).not.toEqual(0);


    });

    test('private and non restricted public without private subnets', () => {
      const { stack } = testFixture();

      new eks.Cluster(stack, 'Cluster', {
        version: CLUSTER_VERSION,
        prune: false,
        endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
        vpcSubnets: [{ subnetType: ec2.SubnetType.PUBLIC }],
      });

      const nested = stack.node.tryFindChild('@aws-cdk/aws-eks.KubectlProvider') as cdk.NestedStack;
      const template = SynthUtils.toCloudFormation(nested);

      // we don't have private subnets, but we don't need them since public access
      // is not restricted.
      expect(template.Resources.Handler886CB40B.Properties.VpcConfig).toEqual(undefined);


    });

    test('private and non restricted public with private subnets', () => {
      const { stack } = testFixture();

      new eks.Cluster(stack, 'Cluster', {
        version: CLUSTER_VERSION,
        prune: false,
        endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
      });

      const nested = stack.node.tryFindChild('@aws-cdk/aws-eks.KubectlProvider') as cdk.NestedStack;
      const template = SynthUtils.toCloudFormation(nested);

      // we have private subnets so we should use them.
      expect(template.Resources.Handler886CB40B.Properties.VpcConfig.SubnetIds.length).not.toEqual(0);
      expect(template.Resources.Handler886CB40B.Properties.VpcConfig.SecurityGroupIds.length).not.toEqual(0);


    });

    test('private and restricted public without private subnets', () => {
      const { stack } = testFixture();

      expect(() => {
        new eks.Cluster(stack, 'Cluster', {
          version: CLUSTER_VERSION,
          prune: false,
          endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE.onlyFrom('1.2.3.4/32'),
          vpcSubnets: [{ subnetType: ec2.SubnetType.PUBLIC }],
        });
      }).toThrow(/Vpc must contain private subnets when public endpoint access is restricted/);


    });

    test('private and restricted public with private subnets', () => {
      const { stack } = testFixture();

      new eks.Cluster(stack, 'Cluster', {
        version: CLUSTER_VERSION,
        prune: false,
        endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE.onlyFrom('1.2.3.4/32'),
      });

      const nested = stack.node.tryFindChild('@aws-cdk/aws-eks.KubectlProvider') as cdk.NestedStack;
      const template = SynthUtils.toCloudFormation(nested);

      // we have private subnets so we should use them.
      expect(template.Resources.Handler886CB40B.Properties.VpcConfig.SubnetIds.length).not.toEqual(0);
      expect(template.Resources.Handler886CB40B.Properties.VpcConfig.SecurityGroupIds.length).not.toEqual(0);


    });

    test('private endpoint access selects only private subnets from looked up vpc', () => {

      const vpcId = 'vpc-12345';
      // can't use the regular fixture because it also adds a VPC to the stack, which prevents
      // us from setting context.
      const stack = new cdk.Stack(new cdk.App(), 'Stack', {
        env: {
          account: '11112222',
          region: 'us-east-1',
        },
      });
      stack.node.setContext(`vpc-provider:account=${stack.account}:filter.vpc-id=${vpcId}:region=${stack.region}:returnAsymmetricSubnets=true`, {
        vpcId: vpcId,
        vpcCidrBlock: '10.0.0.0/16',
        subnetGroups: [
          {
            name: 'Private',
            type: 'Private',
            subnets: [
              {
                subnetId: 'subnet-private-in-us-east-1a',
                cidr: '10.0.1.0/24',
                availabilityZone: 'us-east-1a',
                routeTableId: 'rtb-06068e4c4049921ef',
              },
            ],
          },
          {
            name: 'Public',
            type: 'Public',
            subnets: [
              {
                subnetId: 'subnet-public-in-us-east-1c',
                cidr: '10.0.0.0/24',
                availabilityZone: 'us-east-1c',
                routeTableId: 'rtb-0ff08e62195198dbb',
              },
            ],
          },
        ],
      });
      const vpc = ec2.Vpc.fromLookup(stack, 'Vpc', {
        vpcId: vpcId,
      });

      new eks.Cluster(stack, 'Cluster', {
        vpc,
        version: CLUSTER_VERSION,
        prune: false,
        endpointAccess: eks.EndpointAccess.PRIVATE,
      });

      const nested = stack.node.tryFindChild('@aws-cdk/aws-eks.KubectlProvider') as cdk.NestedStack;
      const template = SynthUtils.toCloudFormation(nested);

      expect(template.Resources.Handler886CB40B.Properties.VpcConfig.SubnetIds).toEqual([
        'subnet-private-in-us-east-1a',
      ]);


    });

    test('private endpoint access selects only private subnets from looked up vpc with concrete subnet selection', () => {

      const vpcId = 'vpc-12345';
      // can't use the regular fixture because it also adds a VPC to the stack, which prevents
      // us from setting context.
      const stack = new cdk.Stack(new cdk.App(), 'Stack', {
        env: {
          account: '11112222',
          region: 'us-east-1',
        },
      });
      stack.node.setContext(`vpc-provider:account=${stack.account}:filter.vpc-id=${vpcId}:region=${stack.region}:returnAsymmetricSubnets=true`, {
        vpcId: vpcId,
        vpcCidrBlock: '10.0.0.0/16',
        subnetGroups: [
          {
            name: 'Private',
            type: 'Private',
            subnets: [
              {
                subnetId: 'subnet-private-in-us-east-1a',
                cidr: '10.0.1.0/24',
                availabilityZone: 'us-east-1a',
                routeTableId: 'rtb-06068e4c4049921ef',
              },
            ],
          },
          {
            name: 'Public',
            type: 'Public',
            subnets: [
              {
                subnetId: 'subnet-public-in-us-east-1c',
                cidr: '10.0.0.0/24',
                availabilityZone: 'us-east-1c',
                routeTableId: 'rtb-0ff08e62195198dbb',
              },
            ],
          },
        ],
      });
      const vpc = ec2.Vpc.fromLookup(stack, 'Vpc', {
        vpcId: vpcId,
      });

      new eks.Cluster(stack, 'Cluster', {
        vpc,
        version: CLUSTER_VERSION,
        prune: false,
        endpointAccess: eks.EndpointAccess.PRIVATE,
        vpcSubnets: [{
          subnets: [
            ec2.Subnet.fromSubnetId(stack, 'Private', 'subnet-private-in-us-east-1a'),
            ec2.Subnet.fromSubnetId(stack, 'Public', 'subnet-public-in-us-east-1c'),
          ],
        }],
      });

      const nested = stack.node.tryFindChild('@aws-cdk/aws-eks.KubectlProvider') as cdk.NestedStack;
      const template = SynthUtils.toCloudFormation(nested);

      expect(template.Resources.Handler886CB40B.Properties.VpcConfig.SubnetIds).toEqual([
        'subnet-private-in-us-east-1a',
      ]);


    });

    test('private endpoint access selects only private subnets from managed vpc with concrete subnet selection', () => {

      const { stack } = testFixture();

      const vpc = new ec2.Vpc(stack, 'Vpc');

      new eks.Cluster(stack, 'Cluster', {
        vpc,
        version: CLUSTER_VERSION,
        prune: false,
        endpointAccess: eks.EndpointAccess.PRIVATE,
        vpcSubnets: [{
          subnets: [
            vpc.privateSubnets[0],
            vpc.publicSubnets[1],
            ec2.Subnet.fromSubnetId(stack, 'Private', 'subnet-unknown'),
          ],
        }],
      });

      const nested = stack.node.tryFindChild('@aws-cdk/aws-eks.KubectlProvider') as cdk.NestedStack;
      const template = SynthUtils.toCloudFormation(nested);

      expect(template.Resources.Handler886CB40B.Properties.VpcConfig.SubnetIds).toEqual([
        { Ref: 'referencetoStackVpcPrivateSubnet1Subnet8E6A14CBRef' },
        'subnet-unknown',
      ]);


    });

    test('private endpoint access considers specific subnet selection', () => {
      const { stack } = testFixture();
      new eks.Cluster(stack, 'Cluster', {
        version: CLUSTER_VERSION,
        prune: false,
        endpointAccess:
          eks.EndpointAccess.PRIVATE,
        vpcSubnets: [{
          subnets: [ec2.PrivateSubnet.fromSubnetAttributes(stack, 'Private1', {
            subnetId: 'subnet1',
            availabilityZone: 'us-east-1a',
          })],
        }],
      });

      const nested = stack.node.tryFindChild('@aws-cdk/aws-eks.KubectlProvider') as cdk.NestedStack;
      const template = SynthUtils.toCloudFormation(nested);

      expect(template.Resources.Handler886CB40B.Properties.VpcConfig.SubnetIds).toEqual([
        'subnet1',
      ]);


    });

    test('can configure private endpoint access', () => {
      // GIVEN
      const { stack } = testFixture();
      new eks.Cluster(stack, 'Cluster1', { version: CLUSTER_VERSION, endpointAccess: eks.EndpointAccess.PRIVATE, prune: false });

      const app = stack.node.root as cdk.App;
      const template = app.synth().getStackArtifact(stack.stackName).template;
      expect(template.Resources.Cluster1B02DD5A2.Properties.Config.resourcesVpcConfig.endpointPrivateAccess).toEqual(true);
      expect(template.Resources.Cluster1B02DD5A2.Properties.Config.resourcesVpcConfig.endpointPublicAccess).toEqual(false);


    });

    test('kubectl provider chooses only private subnets', () => {

      const { stack } = testFixture();

      const vpc = new ec2.Vpc(stack, 'Vpc', {
        maxAzs: 2,
        natGateways: 1,
        subnetConfiguration: [
          {
            subnetType: ec2.SubnetType.PRIVATE,
            name: 'Private1',
          },
          {
            subnetType: ec2.SubnetType.PUBLIC,
            name: 'Public1',
          },
        ],
      });

      const cluster = new eks.Cluster(stack, 'Cluster1', {
        version: CLUSTER_VERSION,
        prune: false,
        endpointAccess: eks.EndpointAccess.PRIVATE,
        vpc,
      });

      cluster.addManifest('resource', {
        kind: 'ConfigMap',
        apiVersion: 'v1',
        data: {
          hello: 'world',
        },
        metadata: {
          name: 'config-map',
        },
      });

      // the kubectl provider is inside a nested stack.
      const nested = stack.node.tryFindChild('@aws-cdk/aws-eks.KubectlProvider') as cdk.NestedStack;
      expect(nested).toHaveResource('AWS::Lambda::Function', {
        VpcConfig: {
          SecurityGroupIds: [
            {
              Ref: 'referencetoStackCluster18DFEAC17ClusterSecurityGroupId',
            },
          ],
          SubnetIds: [
            {
              Ref: 'referencetoStackVpcPrivate1Subnet1Subnet6764A0F6Ref',
            },
            {
              Ref: 'referencetoStackVpcPrivate1Subnet2SubnetDFD49645Ref',
            },
          ],
        },
      });


    });

    test('kubectl provider limits number of subnets to 16', () => {

      const { stack } = testFixture();

      const subnetConfiguration: ec2.SubnetConfiguration[] = [];

      for (let i = 0; i < 20; i++) {
        subnetConfiguration.push({
          subnetType: ec2.SubnetType.PRIVATE,
          name: `Private${i}`,
        },
        );
      }

      subnetConfiguration.push({
        subnetType: ec2.SubnetType.PUBLIC,
        name: 'Public1',
      });

      const vpc2 = new ec2.Vpc(stack, 'Vpc', {
        maxAzs: 2,
        natGateways: 1,
        subnetConfiguration,
      });

      const cluster = new eks.Cluster(stack, 'Cluster1', {
        version: CLUSTER_VERSION,
        prune: false,
        endpointAccess: eks.EndpointAccess.PRIVATE,
        vpc: vpc2,
      });

      cluster.addManifest('resource', {
        kind: 'ConfigMap',
        apiVersion: 'v1',
        data: {
          hello: 'world',
        },
        metadata: {
          name: 'config-map',
        },
      });

      // the kubectl provider is inside a nested stack.
      const nested = stack.node.tryFindChild('@aws-cdk/aws-eks.KubectlProvider') as cdk.NestedStack;
      const template = SynthUtils.toCloudFormation(nested);
      expect(16).toEqual(template.Resources.Handler886CB40B.Properties.VpcConfig.SubnetIds.length);


    });

    test('kubectl provider considers vpc subnet selection', () => {

      const { stack } = testFixture();

      const subnetConfiguration: ec2.SubnetConfiguration[] = [];

      for (let i = 0; i < 20; i++) {
        subnetConfiguration.push({
          subnetType: ec2.SubnetType.PRIVATE,
          name: `Private${i}`,
        },
        );
      }

      subnetConfiguration.push({
        subnetType: ec2.SubnetType.PUBLIC,
        name: 'Public1',
      });

      const vpc2 = new ec2.Vpc(stack, 'Vpc', {
        maxAzs: 2,
        natGateways: 1,
        subnetConfiguration,
      });

      const cluster = new eks.Cluster(stack, 'Cluster1', {
        version: CLUSTER_VERSION,
        prune: false,
        endpointAccess: eks.EndpointAccess.PRIVATE,
        vpc: vpc2,
        vpcSubnets: [{ subnetGroupName: 'Private1' }, { subnetGroupName: 'Private2' }],
      });

      cluster.addManifest('resource', {
        kind: 'ConfigMap',
        apiVersion: 'v1',
        data: {
          hello: 'world',
        },
        metadata: {
          name: 'config-map',
        },
      });

      // the kubectl provider is inside a nested stack.
      const nested = stack.node.tryFindChild('@aws-cdk/aws-eks.KubectlProvider') as cdk.NestedStack;
      expect(nested).toHaveResource('AWS::Lambda::Function', {
        VpcConfig: {
          SecurityGroupIds: [
            {
              Ref: 'referencetoStackCluster18DFEAC17ClusterSecurityGroupId',
            },
          ],
          SubnetIds: [
            {
              Ref: 'referencetoStackVpcPrivate1Subnet1Subnet6764A0F6Ref',
            },
            {
              Ref: 'referencetoStackVpcPrivate1Subnet2SubnetDFD49645Ref',
            },
            {
              Ref: 'referencetoStackVpcPrivate2Subnet1Subnet586AD392Ref',
            },
            {
              Ref: 'referencetoStackVpcPrivate2Subnet2SubnetE42148C0Ref',
            },
          ],
        },
      });


    });

    test('throw when private access is configured without dns support enabled for the VPC', () => {

      const { stack } = testFixture();

      expect(() => {
        new eks.Cluster(stack, 'Cluster', {
          vpc: new ec2.Vpc(stack, 'Vpc', {
            enableDnsSupport: false,
          }),
          version: CLUSTER_VERSION,
          prune: false,
        });
      }).toThrow(/Private endpoint access requires the VPC to have DNS support and DNS hostnames enabled/);

    });

    test('throw when private access is configured without dns hostnames enabled for the VPC', () => {

      const { stack } = testFixture();

      expect(() => {
        new eks.Cluster(stack, 'Cluster', {
          vpc: new ec2.Vpc(stack, 'Vpc', {
            enableDnsHostnames: false,
          }),
          version: CLUSTER_VERSION,
          prune: false,
        });
      }).toThrow(/Private endpoint access requires the VPC to have DNS support and DNS hostnames enabled/);

    });

    test('throw when cidrs are configured without public access endpoint', () => {

      expect(() => {
        eks.EndpointAccess.PRIVATE.onlyFrom('1.2.3.4/5');
      }).toThrow(/CIDR blocks can only be configured when public access is enabled/);

    });

  });

  test('getServiceLoadBalancerAddress', () => {

    const { stack } = testFixture();
    const cluster = new eks.Cluster(stack, 'Cluster1', { version: CLUSTER_VERSION, prune: false });

    const loadBalancerAddress = cluster.getServiceLoadBalancerAddress('myservice');

    new cdk.CfnOutput(stack, 'LoadBalancerAddress', {
      value: loadBalancerAddress,
    });

    const expectedKubernetesGetId = 'Cluster1myserviceLoadBalancerAddress198CCB03';

    const template = SynthUtils.toCloudFormation(stack);

    // make sure the custom resource is created correctly
    expect(template.Resources[expectedKubernetesGetId].Properties).toEqual({
      ServiceToken: {
        'Fn::GetAtt': [
          'awscdkawseksKubectlProviderNestedStackawscdkawseksKubectlProviderNestedStackResourceA7AEBA6B',
          'Outputs.StackawscdkawseksKubectlProviderframeworkonEvent8897FD9BArn',
        ],
      },
      ClusterName: {
        Ref: 'Cluster1B02DD5A2',
      },
      RoleArn: {
        'Fn::GetAtt': [
          'Cluster1CreationRoleA231BE8D',
          'Arn',
        ],
      },
      ObjectType: 'service',
      ObjectName: 'myservice',
      ObjectNamespace: 'default',
      JsonPath: '.status.loadBalancer.ingress[0].hostname',
      TimeoutSeconds: 300,
    });

    // make sure the attribute points to the expected custom resource and extracts the correct attribute
    expect(template.Outputs.LoadBalancerAddress.Value).toEqual({ 'Fn::GetAtt': [expectedKubernetesGetId, 'Value'] });

  });

  test('custom kubectl layer can be provided', () => {
    // GIVEN
    const { stack } = testFixture();

    // WHEN
    const layer = lambda.LayerVersion.fromLayerVersionArn(stack, 'MyLayer', 'arn:of:layer');
    new eks.Cluster(stack, 'Cluster1', {
      version: CLUSTER_VERSION,
      prune: false,
      kubectlLayer: layer,
    });

    // THEN
    const providerStack = stack.node.tryFindChild('@aws-cdk/aws-eks.KubectlProvider') as cdk.NestedStack;
    expect(providerStack).toHaveResource('AWS::Lambda::Function', {
      Layers: ['arn:of:layer'],
    });


  });

  test('create a cluster using custom resource with secrets encryption using KMS CMK', () => {
    // GIVEN
    const { stack, vpc } = testFixture();

    // WHEN
    new eks.Cluster(stack, 'Cluster', {
      vpc,
      version: CLUSTER_VERSION,
      prune: false,
      secretsEncryptionKey: new kms.Key(stack, 'Key'),
    });

    // THEN
    expect(stack).toHaveResourceLike('Custom::AWSCDK-EKS-Cluster', {
      Config: {
        encryptionConfig: [{
          provider: {
            keyArn: {
              'Fn::GetAtt': [
                'Key961B73FD',
                'Arn',
              ],
            },
          },
          resources: ['secrets'],
        }],
      },
    });

  });

  test('custom memory size for kubectl provider', () => {
    // GIVEN
    const { stack, vpc, app } = testFixture();

    // WHEN
    new eks.Cluster(stack, 'Cluster', {
      vpc,
      version: CLUSTER_VERSION,
      kubectlMemory: cdk.Size.gibibytes(2),
    });

    // THEN
    const casm = app.synth();
    const providerNestedStackTemplate = JSON.parse(fs.readFileSync(path.join(casm.directory, 'StackawscdkawseksKubectlProvider7346F799.nested.template.json'), 'utf-8'));
    expect(providerNestedStackTemplate?.Resources?.Handler886CB40B?.Properties?.MemorySize).toEqual(2048);

  });

  test('custom memory size for imported clusters', () => {
    // GIVEN
    const { stack, app } = testFixture();

    // WHEN
    const cluster = eks.Cluster.fromClusterAttributes(stack, 'Imported', {
      clusterName: 'my-cluster',
      kubectlRoleArn: 'arn:aws:iam::123456789012:role/MyRole',
      kubectlMemory: cdk.Size.gibibytes(4),
    });

    cluster.addManifest('foo', { bar: 123 });

    // THEN
    const casm = app.synth();
    const providerNestedStackTemplate = JSON.parse(fs.readFileSync(path.join(casm.directory, 'StackStackImported1CBA9C50KubectlProviderAA00BA49.nested.template.json'), 'utf-8'));
    expect(providerNestedStackTemplate?.Resources?.Handler886CB40B?.Properties?.MemorySize).toEqual(4096);

  });
});
