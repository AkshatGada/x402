// Synthetic MCP calls only; no transport connection, signer, RPC, or funds.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"reflect"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	x402 "github.com/x402-foundation/x402/go/v2"
	xmcp "github.com/x402-foundation/x402/go/v2/mcp"
	"github.com/x402-foundation/x402/go/v2/types"
)

type fixtureScheme struct{}

func (*fixtureScheme) Scheme() string { return "exact" }
func (*fixtureScheme) CreatePaymentPayload(context.Context, types.PaymentRequirements, x402.PaymentPayloadContext) (types.PaymentPayload, error) {
	return types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{"fixture": "not-a-signature"}}, nil
}

type fixtureCaller struct {
	paid, image, toolError, imageOnly bool
	calls                             int
	last                              *sdk.CallToolResult
}

func (c *fixtureCaller) CallTool(_ context.Context, p *sdk.CallToolParams) (*sdk.CallToolResult, error) {
	c.calls++
	if c.paid && p.Meta[xmcp.MCP_PAYMENT_META_KEY] == nil {
		challenge := map[string]interface{}{"x402Version": 2, "resource": map[string]interface{}{"url": "mcp://tool/fixture"}, "accepts": []interface{}{map[string]interface{}{"scheme": "exact", "network": "eip155:8453", "asset": "fixture-USDC", "amount": "1", "payTo": "fixture-payee", "maxTimeoutSeconds": 60}}}
		b, err := json.Marshal(challenge)
		must(err == nil, "marshal challenge: %v", err)
		return &sdk.CallToolResult{IsError: true, StructuredContent: challenge, Content: []sdk.Content{&sdk.TextContent{Text: string(b)}}}, nil
	}
	text := &sdk.TextContent{Text: "caption", Meta: sdk.Meta{"fixture/content-tag": "text"}, Annotations: &sdk.Annotations{Priority: 0.7}}
	result := &sdk.CallToolResult{Content: []sdk.Content{text}, IsError: c.toolError}
	if c.image {
		image := &sdk.ImageContent{Data: []byte{1, 2, 3}, MIMEType: "image/png"}
		if c.imageOnly {
			result.Content = []sdk.Content{image}
		} else {
			result.Content = append(result.Content, image,
				&sdk.AudioContent{Data: []byte{4, 5, 6}, MIMEType: "audio/wav"},
				&sdk.ResourceLink{URI: "https://fixture.invalid/report", Name: "fixture-report", MIMEType: "application/json"},
				&sdk.EmbeddedResource{Resource: &sdk.ResourceContents{URI: "fixture://report", MIMEType: "text/plain", Text: "embedded fixture"}})
			result.StructuredContent = map[string]interface{}{"label": "fixture-image", "width": 1}
			b, err := json.Marshal(result.StructuredContent)
			must(err == nil, "marshal structured fixture: %v", err)
			text.Text = string(b)
		}
		result.Meta = sdk.Meta{"fixture/vendor-receipt": "kept-by-raw-control"}
	}
	if c.paid {
		if result.Meta == nil {
			result.Meta = sdk.Meta{}
		}
		result.Meta[xmcp.MCP_PAYMENT_RESPONSE_META_KEY] = x402.SettleResponse{Success: true, Transaction: "fixture-only", Network: "eip155:8453"}
	}
	c.last = result
	return result, nil
}
func newClient() *x402.X402Client {
	c := x402.Newx402Client().DisableSpendControls()
	c.Register("eip155:8453", &fixtureScheme{})
	return c
}
func must(ok bool, format string, args ...interface{}) {
	if !ok {
		panic(fmt.Sprintf(format, args...))
	}
}
func wrapper(name string, paid, image, toolError, imageOnly bool) {
	caller := &fixtureCaller{paid: paid, image: image, toolError: toolError, imageOnly: imageOnly}
	client := xmcp.NewX402MCPClient(caller, newClient(), xmcp.Options{})
	result, err := client.CallTool(context.Background(), "fixture", nil)
	must(err == nil, "%s returned error: %v", name, err)
	must(result != nil, "%s nil result", name)
	wantCalls := 1
	if paid {
		wantCalls = 2
	}
	must(caller.calls == wantCalls, "%s calls=%d, want %d", name, caller.calls, wantCalls)
	must(result.PaymentMade == paid, "%s payment-made mismatch", name)
	must(result.IsError == toolError, "%s is-error mismatch", name)
	if paid {
		must(result.PaymentResponse != nil && result.PaymentResponse.Success && result.PaymentResponse.Transaction == "fixture-only" && result.PaymentResponse.Network == "eip155:8453", "%s receipt extraction failed", name)
	} else {
		must(result.PaymentResponse == nil, "%s unexpected receipt", name)
	}
	wantNative, wantReturned := 1, 1
	if image {
		wantNative = 5
	}
	if imageOnly {
		wantNative, wantReturned = 1, 0
	}
	must(len(caller.last.Content) == wantNative, "%s native fixture count=%d, want %d", name, len(caller.last.Content), wantNative)
	must(len(result.Content) == wantReturned, "%s returned count=%d, want observed broken %d", name, len(result.Content), wantReturned)
	if wantReturned == 1 {
		must(result.Content[0].Type == "text" && result.Content[0].Text == caller.last.Content[0].(*sdk.TextContent).Text, "%s text content changed", name)
	}
	field := reflect.ValueOf(result).Elem().FieldByName("RawResult")
	if !field.IsValid() && !image {
		fmt.Printf("PASS %s: existing text projection preserved (%d item)\n", name, len(result.Content))
		return
	}
	if !field.IsValid() {
		fmt.Printf("FAIL %s: native result unavailable; sourceContent=%d projectedContent=%d paymentMade=%t\n", name, len(caller.last.Content), len(result.Content), result.PaymentMade)
		failures++
		return
	}
	raw, ok := field.Interface().(*sdk.CallToolResult)
	must(ok && raw == caller.last, "%s original terminal native result not preserved", name)
	must(reflect.DeepEqual(raw.Content, caller.last.Content) && reflect.DeepEqual(raw.StructuredContent, caller.last.StructuredContent) && reflect.DeepEqual(raw.Meta, caller.last.Meta), "%s native content/structured/meta changed", name)
	fmt.Printf("PASS %s: nativeContent=%d projectedContent=%d isError=%t paymentMade=%t receipt=%t\n", name, len(raw.Content), len(result.Content), result.IsError, result.PaymentMade, result.PaymentResponse != nil)

}
func helper() {
	caller := &fixtureCaller{paid: true, image: true}
	result, err := xmcp.CallPaidTool(context.Background(), caller, newClient(), "fixture", nil)
	must(err == nil && result != nil, "CallPaidTool error: %v", err)
	must(caller.calls == 2, "CallPaidTool calls=%d", caller.calls)
	must(len(result.Content) == 5 && result.RawResult == caller.last, "CallPaidTool native content/raw result lost")
	must(reflect.DeepEqual(result.RawResult.StructuredContent, map[string]interface{}{"label": "fixture-image", "width": 1}), "CallPaidTool structured content lost")
	must(result.RawResult.Meta["fixture/vendor-receipt"] == "kept-by-raw-control", "CallPaidTool vendor meta lost")
	text, ok := result.Content[0].(*sdk.TextContent)
	must(ok && text.Annotations != nil && text.Annotations.Priority == 0.7 && text.Meta["fixture/content-tag"] == "text", "CallPaidTool text annotations/meta lost")
	_, image := result.Content[1].(*sdk.ImageContent)
	_, audio := result.Content[2].(*sdk.AudioContent)
	_, link := result.Content[3].(*sdk.ResourceLink)
	_, embedded := result.Content[4].(*sdk.EmbeddedResource)
	must(image && audio && link && embedded, "CallPaidTool native content types lost")
	must(result.PaymentMade && result.PaymentResponse != nil && result.PaymentResponse.Success && result.PaymentResponse.Transaction == "fixture-only", "CallPaidTool receipt extraction failed")
	fmt.Printf("PASS CallPaidTool-control: calls=%d sourceContent=5 returnedContent=%d image=true audio=true resourceLink=true embeddedResource=true structured=true vendorMeta=true textAnnotations=true paymentMade=%t receipt=true\n", caller.calls, len(result.Content), result.PaymentMade)
}

var failures int

func main() {
	wrapper("text-positive-control", false, false, false, false)
	wrapper("free-mixed-content", false, true, false, false)
	wrapper("paid-mixed-content", true, true, false, false)
	wrapper("paid-image-only", true, true, false, true)
	wrapper("non-payment-tool-error", false, true, true, false)
	helper()
	if failures != 0 {
		fmt.Printf("Native-result preservation failed in %d wrapper scenarios\n", failures)
		os.Exit(1)
	}
	fmt.Println("All 6 native-result preservation scenarios passed")
}
