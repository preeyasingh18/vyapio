import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { EventBus } from 'aws-cdk-lib/aws-events';
import { Topic } from 'aws-cdk-lib/aws-sns';

/**
 * EventBridge and SNS.
 *
 * Business events are published after a write commits, and a rule routes them
 * back to the same Lambda. The point is latency, not architecture: the
 * shopkeeper's sale is acknowledged immediately, and the consequences —
 * recomputing sales velocity, refreshing insights — happen out of band.
 *
 * Handlers are convergent rather than incremental, which is what makes
 * EventBridge's at-least-once delivery harmless. See backend/src/handlers.ts.
 *
 * This stack holds only the bus and the topic. The rule that targets the
 * function — and its dead-letter queue — live in the Lambda stack, because
 * EventBridge grants the rule's ARN on the queue, and a queue over here would
 * make Events reference Lambda while Lambda already references the bus.
 */
export class EventsStack extends Stack {
  readonly eventBus: EventBus;
  readonly topic: Topic;

  constructor(scope: Construct, id: string, props: StackProps & { stage: string }) {
    super(scope, id, props);

    this.eventBus = new EventBus(this, 'VyapioEventBus', {
      eventBusName: `vyapio-${props.stage}`,
    });

    this.topic = new Topic(this, 'VyapioNotifications', {
      topicName: `vyapio-${props.stage}-notifications`,
      displayName: 'Vyapio',
    });

    new CfnOutput(this, 'EventBusName', {
      value: this.eventBus.eventBusName,
      description: 'Set this as EVENT_BUS_NAME',
      exportName: `Vyapio-${props.stage}-EventBusName`,
    });

    new CfnOutput(this, 'TopicArn', {
      value: this.topic.topicArn,
      description: 'Set as SNS_TOPIC_ARN, with NOTIFICATION_PROVIDER=sns',
      exportName: `Vyapio-${props.stage}-TopicArn`,
    });
  }
}
