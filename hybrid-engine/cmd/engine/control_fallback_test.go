package main

import "testing"

func TestResolveControlFallback(t *testing.T) {
	tests := []struct {
		name    string
		flagSet bool
		flagVal bool
		envRaw  string
		want    bool
		wantErr bool
	}{
		{name: "defaults to false", flagSet: false, flagVal: false, envRaw: "", want: false},
		{name: "env true", flagSet: false, flagVal: false, envRaw: "true", want: true},
		{name: "env false", flagSet: false, flagVal: false, envRaw: "false", want: false},
		{name: "env 1", flagSet: false, flagVal: false, envRaw: "1", want: true},
		{name: "env 0", flagSet: false, flagVal: false, envRaw: "0", want: false},
		{name: "flag overrides env", flagSet: true, flagVal: true, envRaw: "false", want: true},
		{name: "invalid env fails", flagSet: false, flagVal: false, envRaw: "not-a-bool", wantErr: true},
		{name: "invalid env fails even when flag set", flagSet: true, flagVal: true, envRaw: "yes", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveControlFallback(tt.flagSet, tt.flagVal, tt.envRaw)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error for env %q, got value %v", tt.envRaw, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("resolveControlFallback = %v, want %v", got, tt.want)
			}
		})
	}
}
