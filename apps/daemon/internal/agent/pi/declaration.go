// Package pi implements the Runtime adapter declaration for the Pi coding
// agent. Pi runs as a child process and speaks its native RPC mode over stdio;
// the adapter never reimplements Pi's model or tool loop.
//
// The execution runtime lands with the RPC transport and Turn lifecycle. Until
// then discovery reports the adapter as unavailable, so no Session can select
// a capability this build cannot serve.
package pi

import (
	"context"
	"fmt"

	"github.com/MiniMax-AI/OpenAgentCore/apps/daemon/internal/agent"
	"github.com/MiniMax-AI/OpenAgentCore/internal/agentdaemon/proto"
	configuration "github.com/MiniMax-AI/OpenAgentCore/internal/harnessconfig/pi"
)

// Declaration owns Pi discovery, configuration and execution factories.
var Declaration = agent.Declaration{Info: proto.SupportedAgentKind{
	Kind: "pi",
	Capabilities: proto.AgentKindCapabilities{
		SubagentObservations:           proto.CapabilityUnsupported,
		Streaming:                      proto.CapabilitySupported,
		Usage:                          proto.CapabilitySupported,
		Resume:                         proto.CapabilitySupported,
		RetainedNativeHistory:          proto.CapabilitySupported,
		NativeSessionRecovery:          proto.CapabilityUnsupported,
		Steering:                       proto.CapabilitySupported,
		MessageItems:                   proto.CapabilitySupported,
		ToolObservations:               proto.CapabilitySupported,
		EnvironmentNone:                proto.CapabilitySupported,
		LocalEnvironment:               proto.CapabilitySupported,
		Preparation:                    proto.CapabilityUnsupported,
		WorkspaceReadPreparation:       proto.CapabilityUnsupported,
		WorkspaceOutputExport:          proto.CapabilityUnsupported,
		ProgrammaticToolCallingDisable: proto.CapabilityUnsupported,
		WebSearchControl:               proto.CapabilityUnsupported,
		ExecutionControls:              proto.CapabilityUnsupported,
		TextVerbosity:                  proto.CapabilityUnsupported,
		StructuredOutput:               proto.CapabilityUnsupported,
		ToolSearch:                     proto.CapabilityUnsupported,
		MessageImages:                  proto.CapabilityUnsupported,
		FunctionResultImages:           proto.CapabilityUnsupported,
		SubagentControl:                proto.CapabilityUnsupported,
		DurableInputReceipts:           proto.CapabilitySupported,
		DurableTurns:                   proto.CapabilitySupported,
		FunctionTools:                  proto.CapabilityUnsupported,
		MCPHTTPTools:                   proto.CapabilityUnsupported,
		MCPHTTPRequired:                proto.CapabilityUnsupported,
		MCPHTTPBearerAuth:              proto.CapabilityUnsupported,
	},
}, Configuration: configuration.Configuration(), Discover: discover}

// discover reports the adapter as unavailable until its execution runtime is
// registered. Version probing, configuration rendering and the Executor factory
// belong to that runtime, not to this declaration.
func discover(_ context.Context, options agent.DiscoveryOptions, info proto.SupportedAgentKind) *agent.Runtime {
	fmt.Fprintln(options.Stderr, "oac-daemon: pi unavailable: this build has no Pi execution runtime")
	return &agent.Runtime{Info: info}
}
